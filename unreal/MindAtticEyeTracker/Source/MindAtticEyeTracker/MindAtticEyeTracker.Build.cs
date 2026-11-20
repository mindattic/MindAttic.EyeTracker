using UnrealBuildTool;

public class MindAtticEyeTracker : ModuleRules
{
	public MindAtticEyeTracker(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[] {
			"Core",
			"CoreUObject",
			"Engine",
		});

		PrivateDependencyModuleNames.AddRange(new string[] {
			"WebSockets",
			"Json",
			"JsonUtilities",
		});
	}
}
