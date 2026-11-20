#pragma once

#include "CoreMinimal.h"
#include "GazeTypes.generated.h"

/**
 * One gaze reading from a tracker, as sent over the bridge (docs/PROTOCOL.md, message "gaze").
 * The point is in normalized display space: (0, 0) is the top-left corner of the play area and
 * (1, 1) the bottom-right, X to the right and Y downward.
 */
USTRUCT(BlueprintType)
struct MINDATTICEYETRACKER_API FGazeSample
{
	GENERATED_BODY()

	/** Capture time in milliseconds on the tracker's clock. Only differences are meaningful. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double T = 0.0;

	/** Smoothed gaze point, clamped to 0..1. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double X = 0.5;

	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double Y = 0.5;

	/** Unsmoothed, unclamped estimate. Outside 0..1 when the user looks past the edge. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double RawX = 0.5;

	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double RawY = 0.5;

	/** 0..1. Zero when no face is visible or during a blink. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double Confidence = 0.0;

	/** A face was found in this frame. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	bool bFace = false;

	/** The eyes are closed; X and Y repeat the last open-eye value. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	bool bBlink = false;

	/** A fitted calibration is in use. False means the rough built-in mapping. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	bool bCalibrated = false;
};

/** The tracker's answer to a calibration (message "calib.result"). */
USTRUCT(BlueprintType)
struct MINDATTICEYETRACKER_API FGazeCalibrationResult
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	bool bOk = false;

	/** Why it failed, when bOk is false. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	FString Reason;

	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	int32 Targets = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	int32 Samples = 0;

	/** Error on the points the fit was trained on, in display units. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double FitError = 0.0;

	/** Expected error on points the fit was not trained on. 0.03 means about 3% of the screen. */
	UPROPERTY(BlueprintReadOnly, Category = "Gaze")
	double CrossError = 0.0;
};
