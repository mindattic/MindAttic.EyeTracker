#pragma once

#include "CoreMinimal.h"
#include "GazeTypes.h"
#include "Tickable.h"
#include "UObject/Object.h"
#include "GazeCalibrator.generated.h"

class UGazeTrackerSubsystem;

UENUM(BlueprintType)
enum class EGazeCalibrationState : uint8
{
	/** Not calibrating. */
	Idle,
	/** A target is shown and the eye is given time to land on it. */
	Settling,
	/** The tracker is sampling the eyes on the current target. */
	Collecting,
	/** All targets are done and the tracker is fitting the model. */
	Fitting,
	/** The result is in and its message is on show for a moment. */
	ShowingResult,
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGazeCalibrationFinishedSignature, const FGazeCalibrationResult&, Result);

/**
 * Runs the calibration flow against a UGazeTrackerSubsystem: nine targets by default (the centre,
 * the four corners and the four edge midpoints, each 8% in from the edge), 700 ms for the eye to
 * land on each, then 900 ms of sampling.
 *
 * It draws nothing. Whatever HUD the game has reads GetCurrentTarget and GetCollectProgress each
 * frame and draws the dot. The targets are normalized display points, so draw them over the same
 * area the gaze is meant to cover (usually the whole viewport).
 *
 * Create one with NewObject and keep it in a UPROPERTY. It ticks itself while it is running.
 */
UCLASS(BlueprintType)
class MINDATTICEYETRACKER_API UGazeCalibrator : public UObject, public FTickableGameObject
{
	GENERATED_BODY()

public:
	/** The standard pattern of 5, 9 or 13 targets. Any other count gives 9. */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	static TArray<FVector2D> MakePattern(int32 Count = 9, double Margin = 0.08);

	/** Start calibrating. Returns false, with the reason in GetResult, if no tracker is connected. */
	UFUNCTION(BlueprintCallable, Category = "Gaze|Calibration")
	bool Start(UGazeTrackerSubsystem* InTracker);

	/** Stop without fitting. The result is "cancelled" and OnFinished fires. */
	UFUNCTION(BlueprintCallable, Category = "Gaze|Calibration")
	void Cancel();

	/** True from Start until the result message has been shown. Pause the game while this is true. */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	bool IsActive() const { return State != EGazeCalibrationState::Idle; }

	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	EGazeCalibrationState GetState() const { return State; }

	/** True while a target should be drawn (Settling or Collecting). */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	bool HasTarget() const { return State == EGazeCalibrationState::Settling || State == EGazeCalibrationState::Collecting; }

	/** The target to draw, as a normalized display point (0..1, Y down). */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	FVector2D GetCurrentTarget() const;

	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	int32 GetTargetIndex() const { return TargetIndex; }

	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	int32 GetTargetCount() const { return Targets.Num(); }

	/** 0 while settling, rising to 1 over the sampling time. Use it to fill the dot. */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	double GetCollectProgress() const;

	/** The outcome of the last run. */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	const FGazeCalibrationResult& GetResult() const { return Result; }

	/** A line of text for the player: empty while targets are shown, then "Working it out..." and the outcome. */
	UFUNCTION(BlueprintPure, Category = "Gaze|Calibration")
	FString GetStatusText() const { return Message; }

	/** Fires once per run when the outcome is known (or the run is cancelled). */
	UPROPERTY(BlueprintAssignable, Category = "Gaze|Calibration")
	FGazeCalibrationFinishedSignature OnFinished;

	/** How many targets: 5 is quick, 9 the default, 13 the most accurate. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Gaze|Calibration")
	int32 PointCount = 9;

	/** Your own targets, as normalized display points. Overrides PointCount when not empty. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Gaze|Calibration")
	TArray<FVector2D> CustomTargets;

	/** Time to let the eye land on a target before sampling starts. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Gaze|Calibration")
	double SettleSeconds = 0.7;

	/** Time spent sampling each target. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Gaze|Calibration")
	double CollectSeconds = 0.9;

	// FTickableGameObject
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual ETickableTickType GetTickableTickType() const override;
	virtual bool IsTickable() const override { return State != EGazeCalibrationState::Idle; }
	virtual bool IsTickableWhenPaused() const override { return true; }
	virtual UWorld* GetTickableGameObjectWorld() const override { return GetWorld(); }

private:
	void BeginTarget(int32 Index);
	void BeginCollect();
	void BeginFit();
	void Finish(const FGazeCalibrationResult& InResult);

	UPROPERTY(Transient)
	TObjectPtr<UGazeTrackerSubsystem> Tracker;

	EGazeCalibrationState State = EGazeCalibrationState::Idle;
	TArray<FVector2D> Targets;
	int32 TargetIndex = 0;
	double StateTime = 0.0;
	double ResultShowSeconds = 0.0;
	/** Bumped by every Start and Cancel, so answers to an older run are ignored. */
	int32 RunId = 0;
	FGazeCalibrationResult Result;
	FString Message;
};
