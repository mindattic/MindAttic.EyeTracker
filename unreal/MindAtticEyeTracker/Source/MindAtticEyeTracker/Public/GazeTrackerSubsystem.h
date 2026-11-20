#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "GazeTypes.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GazeTrackerSubsystem.generated.h"

class IWebSocket;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGazeSampleSignature, const FGazeSample&, Sample);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGazePeersSignature, int32, Trackers, int32, Displays);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGazeConnectionSignature, bool, bConnected);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGazeCalibrationResultSignature, const FGazeCalibrationResult&, Result);
DECLARE_DYNAMIC_DELEGATE_OneParam(FGazeCollectedDelegate, int32, Samples);

/**
 * A display's connection to the MindAttic.EyeTracker bridge (docs/PROTOCOL.md, version 1).
 *
 * The tracker page in a browser owns the camera. This subsystem says hello as a "display",
 * receives the gaze point about 30 times a second, and can drive the tracker's calibration: the
 * game draws the targets, the tracker collects the eye samples.
 *
 * All callbacks and delegates fire on the game thread.
 */
UCLASS()
class MINDATTICEYETRACKER_API UGazeTrackerSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Deinitialize() override;

	/**
	 * Connect to the bridge and keep the connection: if it drops, or the bridge is not running yet,
	 * the subsystem tries again every ReconnectSeconds until Disconnect is called.
	 */
	UFUNCTION(BlueprintCallable, Category = "Gaze")
	void Connect(const FString& Url = TEXT("ws://localhost:8787/gaze"), const FString& Room = TEXT("default"));

	/** Close the connection and stop reconnecting. */
	UFUNCTION(BlueprintCallable, Category = "Gaze")
	void Disconnect();

	/** True while the WebSocket to the bridge is open. */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	bool IsConnected() const { return bConnected; }

	/** How many trackers share the room. Show "waiting for a tracker" while this is zero. */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	int32 GetTrackerCount() const { return TrackerCount; }

	UFUNCTION(BlueprintPure, Category = "Gaze")
	int32 GetDisplayCount() const { return DisplayCount; }

	/** The most recent gaze message, exactly as received. Check HasSample first. */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	const FGazeSample& GetLatest() const { return Latest; }

	/** True once any gaze message has arrived on this connection. */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	bool HasSample() const { return bHasSample; }

	/** Seconds since the latest gaze message arrived. Very large when none has. */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	double GetSampleAge() const;

	/**
	 * True when the eyes are tracked right now: a tracker is present, the latest message is newer
	 * than MaxAgeSeconds and its confidence is above zero.
	 */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	bool IsTracking(double MaxAgeSeconds = 0.4) const;

	/**
	 * The gaze point in normalized display space (0..1, Y down). While the confidence is zero this
	 * holds the last good point, as the protocol asks.
	 */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	FVector2D GetGazePoint() const { return HeldPoint; }

	/** GetGazePoint in viewport pixels, with (0, 0) at the top-left of the game viewport. */
	UFUNCTION(BlueprintPure, Category = "Gaze")
	FVector2D GetViewportPoint() const;

	// Calibration. The display draws each target; the tracker samples the eyes while it is shown.

	/** Start a new calibration on every tracker in the room. */
	UFUNCTION(BlueprintCallable, Category = "Gaze|Calibration")
	void CalibBegin();

	/**
	 * Ask the tracker to sample the eyes for Ms milliseconds while the user looks at (X, Y), a
	 * normalized display point. OnCollected fires with the number of samples taken, or with zero if
	 * the tracker does not answer within Ms plus 3 seconds.
	 */
	UFUNCTION(BlueprintCallable, Category = "Gaze|Calibration")
	void CalibCollect(double X, double Y, int32 Ms, FGazeCollectedDelegate OnCollected);

	/** Fit the calibration. The answer arrives on OnCalibrationResult (within 8 seconds). */
	UFUNCTION(BlueprintCallable, Category = "Gaze|Calibration")
	void CalibFinish();

	/** Drop the calibration and go back to the rough built-in mapping. */
	UFUNCTION(BlueprintCallable, Category = "Gaze|Calibration")
	void CalibClear();

	/** CalibCollect for C++ callers. */
	void CalibCollectNative(double X, double Y, int32 Ms, TFunction<void(int32 Samples)> OnCollected);

	/** CalibFinish for C++ callers. OnResult fires before OnCalibrationResult is broadcast. */
	void CalibFinishNative(TFunction<void(const FGazeCalibrationResult& Result)> OnResult);

	/** Fires for every gaze message. */
	UPROPERTY(BlueprintAssignable, Category = "Gaze")
	FGazeSampleSignature OnGaze;

	/** Fires when a tracker or display joins or leaves the room, and when the connection drops. */
	UPROPERTY(BlueprintAssignable, Category = "Gaze")
	FGazePeersSignature OnPeersChanged;

	/** Fires when the connection to the bridge opens or closes. */
	UPROPERTY(BlueprintAssignable, Category = "Gaze")
	FGazeConnectionSignature OnConnectionChanged;

	/** Fires with the outcome of every CalibFinish. */
	UPROPERTY(BlueprintAssignable, Category = "Gaze|Calibration")
	FGazeCalibrationResultSignature OnCalibrationResult;

	/** Seconds between reconnection attempts. Zero turns reconnection off. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Gaze")
	double ReconnectSeconds = 1.5;

	/** The name sent in hello. It only appears in the bridge's log. Defaults to the project name. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Gaze")
	FString ClientName;

private:
	struct FPendingRequest
	{
		double Deadline = 0.0;
		bool bIsFinish = false;
		TFunction<void(int32)> OnCollected;
		TFunction<void(const FGazeCalibrationResult&)> OnResult;
	};

	void OpenSocket();
	/** Drop the socket without firing its callbacks again. */
	void DropSocket();
	void HandleOpened();
	void HandleClosed(const FString& Why);
	void HandleMessage(const FString& Text);
	bool SendJson(const TSharedRef<class FJsonObject>& Message);
	void EnsureTicker();
	bool TickSubsystem(float DeltaSeconds);
	/** Answer one waiting request. Reply is null on a timeout or a lost connection. */
	void Resolve(int32 Id, const TSharedPtr<class FJsonObject>& Reply, const FString& FailureReason);
	void FailAllPending(const FString& Reason);

	TSharedPtr<IWebSocket> Socket;
	/** Sockets that closed inside their own callback; released on the next tick. */
	TArray<TSharedPtr<IWebSocket>> RetiredSockets;
	/** Bumped every time a socket is opened or dropped, so callbacks from an old one are ignored. */
	int32 SocketGeneration = 0;

	FString BridgeUrl;
	FString BridgeRoom;
	bool bWantConnection = false;
	bool bConnected = false;
	double NextReconnectAt = 0.0;
	FTSTicker::FDelegateHandle TickerHandle;

	int32 TrackerCount = 0;
	int32 DisplayCount = 0;

	FGazeSample Latest;
	bool bHasSample = false;
	double LatestAt = 0.0;
	FVector2D HeldPoint = FVector2D(0.5, 0.5);

	int32 NextRequestId = 1;
	TMap<int32, FPendingRequest> Pending;
};
