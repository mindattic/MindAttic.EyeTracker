#include "GazeTrackerSubsystem.h"

#include "Dom/JsonObject.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "IWebSocket.h"
#include "MindAtticEyeTrackerModule.h"
#include "Misc/App.h"
#include "Modules/ModuleManager.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"

namespace
{
	const int32 GazeProtocolVersion = 1;
	/** How long past the sampling time to wait for calib.collected. */
	const double GazeCollectGraceSeconds = 3.0;
	const double GazeFinishTimeoutSeconds = 8.0;
}

void UGazeTrackerSubsystem::Deinitialize()
{
	Disconnect();
	if (TickerHandle.IsValid())
	{
		FTSTicker::RemoveTicker(TickerHandle);
		TickerHandle.Reset();
	}
	RetiredSockets.Empty();
	Super::Deinitialize();
}

void UGazeTrackerSubsystem::Connect(const FString& Url, const FString& Room)
{
	Disconnect();
	BridgeUrl = Url.IsEmpty() ? FString(TEXT("ws://localhost:8787/gaze")) : Url;
	BridgeRoom = Room.IsEmpty() ? FString(TEXT("default")) : Room;
	bWantConnection = true;
	EnsureTicker();
	OpenSocket();
}

void UGazeTrackerSubsystem::Disconnect()
{
	bWantConnection = false;
	const bool bWasConnected = bConnected;
	DropSocket();
	bConnected = false;
	bHasSample = false;
	FailAllPending(TEXT("disconnected"));
	if (TrackerCount != 0 || DisplayCount != 0)
	{
		TrackerCount = 0;
		DisplayCount = 0;
		OnPeersChanged.Broadcast(0, 0);
	}
	if (bWasConnected)
	{
		OnConnectionChanged.Broadcast(false);
	}
}

double UGazeTrackerSubsystem::GetSampleAge() const
{
	return bHasSample ? FPlatformTime::Seconds() - LatestAt : 1.0e9;
}

bool UGazeTrackerSubsystem::IsTracking(double MaxAgeSeconds) const
{
	return bConnected && TrackerCount > 0 && bHasSample && Latest.Confidence > 0.0 && GetSampleAge() <= MaxAgeSeconds;
}

FVector2D UGazeTrackerSubsystem::GetViewportPoint() const
{
	FVector2D Size(0.0, 0.0);
	if (const UGameInstance* GameInstance = GetGameInstance())
	{
		if (UGameViewportClient* Viewport = GameInstance->GetGameViewportClient())
		{
			Viewport->GetViewportSize(Size);
		}
	}
	return FVector2D(HeldPoint.X * Size.X, HeldPoint.Y * Size.Y);
}

void UGazeTrackerSubsystem::EnsureTicker()
{
	if (!TickerHandle.IsValid())
	{
		TickerHandle = FTSTicker::GetCoreTicker().AddTicker(
			FTickerDelegate::CreateUObject(this, &UGazeTrackerSubsystem::TickSubsystem), 0.1f);
	}
}

void UGazeTrackerSubsystem::OpenSocket()
{
	DropSocket();
	if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
	{
		FModuleManager::Get().LoadModule(TEXT("WebSockets"));
	}

	const int32 Generation = ++SocketGeneration;
	TSharedRef<IWebSocket> NewSocket = FWebSocketsModule::Get().CreateWebSocket(BridgeUrl, FString());
	Socket = NewSocket;

	NewSocket->OnConnected().AddWeakLambda(this, [this, Generation]()
	{
		if (Generation == SocketGeneration)
		{
			HandleOpened();
		}
	});
	NewSocket->OnConnectionError().AddWeakLambda(this, [this, Generation](const FString& Error)
	{
		if (Generation == SocketGeneration)
		{
			HandleClosed(Error);
		}
	});
	NewSocket->OnClosed().AddWeakLambda(this, [this, Generation](int32 /*StatusCode*/, const FString& Reason, bool /*bWasClean*/)
	{
		if (Generation == SocketGeneration)
		{
			HandleClosed(Reason);
		}
	});
	NewSocket->OnMessage().AddWeakLambda(this, [this, Generation](const FString& Text)
	{
		if (Generation == SocketGeneration)
		{
			HandleMessage(Text);
		}
	});

	NewSocket->Connect();
}

void UGazeTrackerSubsystem::DropSocket()
{
	++SocketGeneration;
	if (Socket.IsValid())
	{
		if (Socket->IsConnected())
		{
			Socket->Close();
		}
		// This can run inside one of the socket's own callbacks, so it is released on a later tick.
		RetiredSockets.Add(Socket);
		Socket.Reset();
	}
}

void UGazeTrackerSubsystem::HandleOpened()
{
	bConnected = true;
	UE_LOG(LogMindAtticEyeTracker, Log, TEXT("Connected to the bridge at %s (room %s)."), *BridgeUrl, *BridgeRoom);

	const TSharedRef<FJsonObject> Hello = MakeShared<FJsonObject>();
	Hello->SetStringField(TEXT("type"), TEXT("hello"));
	Hello->SetNumberField(TEXT("v"), GazeProtocolVersion);
	Hello->SetStringField(TEXT("role"), TEXT("display"));
	Hello->SetStringField(TEXT("room"), BridgeRoom);
	Hello->SetStringField(TEXT("name"), ClientName.IsEmpty() ? FString(FApp::GetProjectName()) : ClientName);
	SendJson(Hello);

	OnConnectionChanged.Broadcast(true);
}

void UGazeTrackerSubsystem::HandleClosed(const FString& Why)
{
	const bool bWasConnected = bConnected;
	if (bWasConnected)
	{
		UE_LOG(LogMindAtticEyeTracker, Log, TEXT("The bridge connection closed (%s)."), *Why);
	}
	DropSocket();
	bConnected = false;
	bHasSample = false;
	NextReconnectAt = FPlatformTime::Seconds() + ReconnectSeconds;
	FailAllPending(TEXT("the connection to the bridge was lost"));
	if (TrackerCount != 0 || DisplayCount != 0)
	{
		TrackerCount = 0;
		DisplayCount = 0;
		OnPeersChanged.Broadcast(0, 0);
	}
	if (bWasConnected)
	{
		OnConnectionChanged.Broadcast(false);
	}
}

void UGazeTrackerSubsystem::HandleMessage(const FString& Text)
{
	TSharedPtr<FJsonObject> Message;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Message) || !Message.IsValid())
	{
		return;
	}
	FString Type;
	if (!Message->TryGetStringField(TEXT("type"), Type))
	{
		return;
	}

	if (Type == TEXT("gaze"))
	{
		FGazeSample Sample;
		Message->TryGetNumberField(TEXT("t"), Sample.T);
		Message->TryGetNumberField(TEXT("x"), Sample.X);
		Message->TryGetNumberField(TEXT("y"), Sample.Y);
		Sample.RawX = Sample.X;
		Sample.RawY = Sample.Y;
		Message->TryGetNumberField(TEXT("rawX"), Sample.RawX);
		Message->TryGetNumberField(TEXT("rawY"), Sample.RawY);
		Message->TryGetNumberField(TEXT("confidence"), Sample.Confidence);
		Message->TryGetBoolField(TEXT("face"), Sample.bFace);
		Message->TryGetBoolField(TEXT("blink"), Sample.bBlink);
		Message->TryGetBoolField(TEXT("calibrated"), Sample.bCalibrated);

		Latest = Sample;
		bHasSample = true;
		LatestAt = FPlatformTime::Seconds();
		if (Sample.Confidence > 0.0)
		{
			HeldPoint = FVector2D(Sample.X, Sample.Y);
		}
		OnGaze.Broadcast(Latest);
	}
	else if (Type == TEXT("peers") || Type == TEXT("welcome"))
	{
		int32 Trackers = 0;
		int32 Displays = 0;
		Message->TryGetNumberField(TEXT("trackers"), Trackers);
		Message->TryGetNumberField(TEXT("displays"), Displays);
		TrackerCount = Trackers;
		DisplayCount = Displays;
		if (TrackerCount == 0)
		{
			bHasSample = false;
		}
		OnPeersChanged.Broadcast(TrackerCount, DisplayCount);
	}
	else if (Type == TEXT("calib.collected") || Type == TEXT("calib.result"))
	{
		int32 Id = 0;
		if (Message->TryGetNumberField(TEXT("id"), Id))
		{
			Resolve(Id, Message, FString());
		}
	}
	// Unknown types are ignored, as the protocol requires.
}

bool UGazeTrackerSubsystem::SendJson(const TSharedRef<FJsonObject>& Message)
{
	if (!Socket.IsValid() || !Socket->IsConnected())
	{
		return false;
	}
	FString Text;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text);
	if (!FJsonSerializer::Serialize(Message, Writer))
	{
		return false;
	}
	Socket->Send(Text);
	return true;
}

void UGazeTrackerSubsystem::CalibBegin()
{
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("type"), TEXT("calib"));
	Message->SetStringField(TEXT("op"), TEXT("begin"));
	SendJson(Message);
}

void UGazeTrackerSubsystem::CalibClear()
{
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("type"), TEXT("calib"));
	Message->SetStringField(TEXT("op"), TEXT("clear"));
	SendJson(Message);
}

void UGazeTrackerSubsystem::CalibCollect(double X, double Y, int32 Ms, FGazeCollectedDelegate OnCollected)
{
	CalibCollectNative(X, Y, Ms, [OnCollected](int32 Samples)
	{
		OnCollected.ExecuteIfBound(Samples);
	});
}

void UGazeTrackerSubsystem::CalibCollectNative(double X, double Y, int32 Ms, TFunction<void(int32 Samples)> OnCollected)
{
	const int32 Id = NextRequestId++;
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("type"), TEXT("calib"));
	Message->SetStringField(TEXT("op"), TEXT("collect"));
	Message->SetNumberField(TEXT("id"), Id);
	Message->SetNumberField(TEXT("x"), X);
	Message->SetNumberField(TEXT("y"), Y);
	Message->SetNumberField(TEXT("ms"), Ms);
	if (!SendJson(Message))
	{
		if (OnCollected)
		{
			OnCollected(0);
		}
		return;
	}
	FPendingRequest Request;
	Request.Deadline = FPlatformTime::Seconds() + Ms / 1000.0 + GazeCollectGraceSeconds;
	Request.OnCollected = MoveTemp(OnCollected);
	Pending.Add(Id, MoveTemp(Request));
	EnsureTicker();
}

void UGazeTrackerSubsystem::CalibFinish()
{
	CalibFinishNative(nullptr);
}

void UGazeTrackerSubsystem::CalibFinishNative(TFunction<void(const FGazeCalibrationResult& Result)> OnResult)
{
	const int32 Id = NextRequestId++;
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("type"), TEXT("calib"));
	Message->SetStringField(TEXT("op"), TEXT("finish"));
	Message->SetNumberField(TEXT("id"), Id);

	FPendingRequest Request;
	Request.bIsFinish = true;
	Request.Deadline = FPlatformTime::Seconds() + GazeFinishTimeoutSeconds;
	Request.OnResult = MoveTemp(OnResult);
	Pending.Add(Id, MoveTemp(Request));
	EnsureTicker();

	if (!SendJson(Message))
	{
		Resolve(Id, nullptr, TEXT("not connected to the bridge"));
	}
}

void UGazeTrackerSubsystem::Resolve(int32 Id, const TSharedPtr<FJsonObject>& Reply, const FString& FailureReason)
{
	FPendingRequest Request;
	if (!Pending.RemoveAndCopyValue(Id, Request))
	{
		return;
	}

	FString ReplyType;
	if (Reply.IsValid())
	{
		Reply->TryGetStringField(TEXT("type"), ReplyType);
	}

	if (!Request.bIsFinish)
	{
		int32 Samples = 0;
		if (ReplyType == TEXT("calib.collected"))
		{
			Reply->TryGetNumberField(TEXT("samples"), Samples);
		}
		if (Request.OnCollected)
		{
			Request.OnCollected(Samples);
		}
		return;
	}

	FGazeCalibrationResult Result;
	if (ReplyType == TEXT("calib.result"))
	{
		Reply->TryGetBoolField(TEXT("ok"), Result.bOk);
		Reply->TryGetStringField(TEXT("reason"), Result.Reason);
		Reply->TryGetNumberField(TEXT("targets"), Result.Targets);
		Reply->TryGetNumberField(TEXT("samples"), Result.Samples);
		Reply->TryGetNumberField(TEXT("fitError"), Result.FitError);
		Reply->TryGetNumberField(TEXT("crossError"), Result.CrossError);
	}
	else
	{
		Result.bOk = false;
		Result.Reason = FailureReason.IsEmpty() ? FString(TEXT("the tracker did not answer")) : FailureReason;
	}
	if (Request.OnResult)
	{
		Request.OnResult(Result);
	}
	OnCalibrationResult.Broadcast(Result);
}

void UGazeTrackerSubsystem::FailAllPending(const FString& Reason)
{
	TArray<int32> Ids;
	Pending.GetKeys(Ids);
	for (const int32 Id : Ids)
	{
		Resolve(Id, nullptr, Reason);
	}
}

bool UGazeTrackerSubsystem::TickSubsystem(float /*DeltaSeconds*/)
{
	RetiredSockets.Reset();

	const double Now = FPlatformTime::Seconds();

	TArray<int32> Expired;
	for (const TPair<int32, FPendingRequest>& Pair : Pending)
	{
		if (Now >= Pair.Value.Deadline)
		{
			Expired.Add(Pair.Key);
		}
	}
	for (const int32 Id : Expired)
	{
		Resolve(Id, nullptr, TEXT("the tracker did not answer"));
	}

	if (bWantConnection && !Socket.IsValid() && ReconnectSeconds > 0.0 && Now >= NextReconnectAt)
	{
		NextReconnectAt = Now + ReconnectSeconds;
		OpenSocket();
	}
	return true;
}
