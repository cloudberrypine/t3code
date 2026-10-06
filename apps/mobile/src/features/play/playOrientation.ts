import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface PlayOrientationModule {
  setRotationAllowed(allowed: boolean): void;
}

// modules/t3-play-orientation: iPhone only; iPad already rotates, and Android
// keeps the app's orientation policy.
const native =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<PlayOrientationModule>("T3PlayOrientation")
    : null;

/** Lets the app rotate to landscape while the play screen is open; false restores portrait. */
export function setPlayRotationAllowed(allowed: boolean): void {
  native?.setRotationAllowed(allowed);
}
