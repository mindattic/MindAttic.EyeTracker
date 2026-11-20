#include "GazeCalibrator.h"

#include "GazeTrackerSubsystem.h"

namespace
{
	/** The follow-the-dot pass waits this long with the dot at the start of its path. */
	const double GazePursuitSettleSeconds = 1.3;
	/** The pass is sampled in slices of this length, each sent as one collect. */
	const double GazePursuitSliceSeconds = 0.2;
}

FVector2D UGazeCalibrator::PursuitPath(double Seconds)
{
	// The reference path from docs/PROTOCOL.md: out and back in every direction, so any lag of the
	// eyes behind the dot cancels instead of biasing the fit.
	return FVector2D(
		0.5 + 0.43 * FMath::Sin(2.0 * UE_DOUBLE_PI * Seconds / 8.0),
		0.5 + 0.41 * FMath::Sin(2.0 * UE_DOUBLE_PI * Seconds / 6.0 + UE_DOUBLE_PI / 2.0));
}

TArray<FVector2D> UGazeCalibrator::MakePattern(int32 Count, double Margin)
{
	const double Lo = Margin;
	const double Hi = 1.0 - Margin;
	const double Mid = 0.5;
	const double Q1 = Lo + (Hi - Lo) * 0.25;
	const double Q3 = Lo + (Hi - Lo) * 0.75;

	// The same order as calibrationPattern in src/calibration.ts.
	TArray<FVector2D> Points;
	Points.Add(FVector2D(Mid, Mid));
	Points.Add(FVector2D(Lo, Lo));
	Points.Add(FVector2D(Hi, Hi));
	Points.Add(FVector2D(Hi, Lo));
	Points.Add(FVector2D(Lo, Hi));
	if (Count == 5)
	{
		return Points;
	}
	Points.Add(FVector2D(Mid, Lo));
	Points.Add(FVector2D(Mid, Hi));
	Points.Add(FVector2D(Lo, Mid));
	Points.Add(FVector2D(Hi, Mid));
	if (Count != 13)
	{
		return Points;
	}
	Points.Add(FVector2D(Q1, Q1));
	Points.Add(FVector2D(Q3, Q3));
	Points.Add(FVector2D(Q3, Q1));
	Points.Add(FVector2D(Q1, Q3));
	return Points;
}

bool UGazeCalibrator::Start(UGazeTrackerSubsystem* InTracker)
{
	if (IsActive())
	{
		Cancel();
	}
	++RunId;
	Tracker = InTracker;
	Result = FGazeCalibrationResult();
	Message.Reset();

	if (!Tracker || !Tracker->IsConnected() || Tracker->GetTrackerCount() == 0)
	{
		Result.Reason = TEXT("no tracker is connected");
		return false;
	}

	Targets.Reset();
	StepSettle.Reset();
	StepCollect.Reset();
	StepHead.Reset();
	StepText.Reset();
	const TArray<FVector2D> Dots = CustomTargets.Num() > 0 ? CustomTargets : MakePattern(PointCount);
	for (const FVector2D& Dot : Dots)
	{
		AddStep(Dot, SettleSeconds, CollectSeconds, false, TEXT("Look at each dot until it fills. Keep your head still and move only your eyes."));
	}
	DotCount = Dots.Num();
	PursuitIndex = INDEX_NONE;
	bPursuitSliceOut = false;
	if (bPursuit && PursuitSeconds > 0.0)
	{
		// Eyes following a moving dot, head still. One step, sampled in 200 ms slices.
		PursuitIndex = Targets.Num();
		AddStep(PursuitPath(0.0), GazePursuitSettleSeconds, PursuitSeconds, false, TEXT("Now follow the dot with your eyes as it moves. Keep your head still."));
	}
	if (bHeadMovement)
	{
		// Eyes fixed, head moving. The reference sequence from docs/PROTOCOL.md.
		AddStep(FVector2D(0.5, 0.5), HeadSettleSeconds, 6.0, true, TEXT("Keep your eyes on the dot and slowly turn your head left and right, then nod up and down."));
		AddStep(FVector2D(0.18, 0.22), HeadSettleSeconds, 4.0, true, TEXT("Eyes on the dot again. Lean a little closer, then back, then side to side."));
		AddStep(FVector2D(0.82, 0.78), HeadSettleSeconds, 4.0, true, TEXT("Once more: eyes on the dot, move your head around gently."));
	}
	Tracker->CalibBegin();
	BeginTarget(0);
	return true;
}

void UGazeCalibrator::AddStep(const FVector2D& Point, double Settle, double Collect, bool bHead, const FString& Text)
{
	Targets.Add(Point);
	StepSettle.Add(Settle);
	StepCollect.Add(Collect);
	StepHead.Add(bHead);
	StepText.Add(Text);
}

void UGazeCalibrator::Cancel()
{
	if (!IsActive())
	{
		return;
	}
	const bool bResultAlreadyOut = State == EGazeCalibrationState::ShowingResult;
	++RunId;
	State = EGazeCalibrationState::Idle;
	Message.Reset();
	if (!bResultAlreadyOut)
	{
		Result = FGazeCalibrationResult();
		Result.Reason = TEXT("cancelled");
		OnFinished.Broadcast(Result);
	}
}

FVector2D UGazeCalibrator::GetCurrentTarget() const
{
	if (TargetIndex == PursuitIndex && State == EGazeCalibrationState::Collecting)
	{
		return PursuitPath(StateTime);
	}
	return Targets.IsValidIndex(TargetIndex) ? Targets[TargetIndex] : FVector2D(0.5, 0.5);
}

double UGazeCalibrator::GetCollectProgress() const
{
	if (State != EGazeCalibrationState::Collecting || !StepCollect.IsValidIndex(TargetIndex) || StepCollect[TargetIndex] <= 0.0)
	{
		return 0.0;
	}
	return FMath::Clamp(StateTime / StepCollect[TargetIndex], 0.0, 1.0);
}

void UGazeCalibrator::BeginTarget(int32 Index)
{
	TargetIndex = Index;
	State = EGazeCalibrationState::Settling;
	StateTime = 0.0;
}

void UGazeCalibrator::BeginCollect()
{
	State = EGazeCalibrationState::Collecting;
	StateTime = 0.0;

	if (TargetIndex == PursuitIndex)
	{
		bPursuitSliceOut = false;
		SendPursuitSlice();
		return;
	}

	const FVector2D Target = GetCurrentTarget();
	const int32 ThisRun = RunId;
	const int32 ThisTarget = TargetIndex;
	TWeakObjectPtr<UGazeCalibrator> WeakThis(this);
	const double CollectFor = StepCollect.IsValidIndex(TargetIndex) ? StepCollect[TargetIndex] : CollectSeconds;
	const bool bHead = StepHead.IsValidIndex(TargetIndex) && StepHead[TargetIndex];
	Tracker->CalibCollectNative(Target.X, Target.Y, FMath::RoundToInt32(CollectFor * 1000.0),
		[WeakThis, ThisRun, ThisTarget](int32 /*Samples*/)
		{
			UGazeCalibrator* Self = WeakThis.Get();
			if (!Self || Self->RunId != ThisRun || Self->State != EGazeCalibrationState::Collecting || Self->TargetIndex != ThisTarget)
			{
				return;
			}
			// The answer, or its timeout, moves on to the next target either way. A target with no
			// samples just contributes nothing to the fit.
			Self->NextStep();
		}, bHead);
}

void UGazeCalibrator::NextStep()
{
	if (TargetIndex + 1 < Targets.Num())
	{
		BeginTarget(TargetIndex + 1);
	}
	else
	{
		BeginFit();
	}
}

void UGazeCalibrator::SendPursuitSlice()
{
	// The position the dot will have at the middle of the slice, so the samples of the slice are
	// centred on it. headMoving marks the samples as taken on the move.
	const FVector2D Middle = PursuitPath(StateTime + GazePursuitSliceSeconds * 0.5);
	const int32 ThisRun = RunId;
	TWeakObjectPtr<UGazeCalibrator> WeakThis(this);
	bPursuitSliceOut = true;
	Tracker->CalibCollectNative(Middle.X, Middle.Y, FMath::RoundToInt32(GazePursuitSliceSeconds * 1000.0),
		[WeakThis, ThisRun](int32 /*Samples*/)
		{
			UGazeCalibrator* Self = WeakThis.Get();
			if (Self && Self->RunId == ThisRun)
			{
				// Tick sends the next slice, or ends the pass. Not from here: the answer can come
				// back at once when the connection is down.
				Self->bPursuitSliceOut = false;
			}
		}, true);
}

void UGazeCalibrator::BeginFit()
{
	State = EGazeCalibrationState::Fitting;
	StateTime = 0.0;
	Message = TEXT("Working it out...");

	const int32 ThisRun = RunId;
	TWeakObjectPtr<UGazeCalibrator> WeakThis(this);
	Tracker->CalibFinishNative([WeakThis, ThisRun](const FGazeCalibrationResult& InResult)
	{
		UGazeCalibrator* Self = WeakThis.Get();
		if (Self && Self->RunId == ThisRun && Self->State == EGazeCalibrationState::Fitting)
		{
			Self->Finish(InResult);
		}
	});
}

void UGazeCalibrator::Finish(const FGazeCalibrationResult& InResult)
{
	Result = InResult;
	State = EGazeCalibrationState::ShowingResult;
	StateTime = 0.0;
	if (Result.bOk)
	{
		Message = FString::Printf(TEXT("Calibrated. Typical error: about %d%% of the screen."), FMath::RoundToInt32(Result.CrossError * 100.0));
		ResultShowSeconds = 1.1;
	}
	else
	{
		Message = FString::Printf(TEXT("Calibration failed: %s."), Result.Reason.IsEmpty() ? TEXT("unknown reason") : *Result.Reason);
		ResultShowSeconds = 2.2;
	}
	OnFinished.Broadcast(Result);
}

void UGazeCalibrator::Tick(float DeltaTime)
{
	StateTime += DeltaTime;
	switch (State)
	{
	case EGazeCalibrationState::Settling:
		if (!Tracker || !Tracker->IsConnected())
		{
			FGazeCalibrationResult Lost;
			Lost.Reason = TEXT("the connection to the bridge was lost");
			Finish(Lost);
		}
		else if (StateTime >= (StepSettle.IsValidIndex(TargetIndex) ? StepSettle[TargetIndex] : SettleSeconds))
		{
			BeginCollect();
		}
		break;
	case EGazeCalibrationState::ShowingResult:
		if (StateTime >= ResultShowSeconds)
		{
			State = EGazeCalibrationState::Idle;
			Message.Reset();
		}
		break;
	case EGazeCalibrationState::Collecting:
		// A dot or a head-movement step ends when the subsystem answers or times the request out.
		// The follow-the-dot pass is a run of slices: each is sent when the one before is answered.
		if (TargetIndex == PursuitIndex && !bPursuitSliceOut)
		{
			if (!Tracker || !Tracker->IsConnected())
			{
				FGazeCalibrationResult Lost;
				Lost.Reason = TEXT("the connection to the bridge was lost");
				Finish(Lost);
			}
			else if (StateTime >= PursuitSeconds)
			{
				NextStep();
			}
			else
			{
				SendPursuitSlice();
			}
		}
		break;
	default:
		// Fitting ends when the subsystem answers or times the request out.
		break;
	}
}

TStatId UGazeCalibrator::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UGazeCalibrator, STATGROUP_Tickables);
}

ETickableTickType UGazeCalibrator::GetTickableTickType() const
{
	return IsTemplate() ? ETickableTickType::Never : ETickableTickType::Conditional;
}
