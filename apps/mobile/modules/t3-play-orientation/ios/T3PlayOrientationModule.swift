import ExpoModulesCore
import UIKit

/// The app's orientations while the Polyzonia play screen is open (fork-only).
///
/// The app is portrait-only on iPhone (Info.plist); a game page may use
/// landscape too. UIKit never rotates past the app's mask, so the play screen
/// widens it while open. Once any app delegate subscriber answers
/// `supportedInterfaceOrientationsFor`, Expo returns the subscribers' answer
/// instead of Info.plist's, so this one answers Info.plist's otherwise.
@MainActor
enum T3PlayOrientationPolicy {
  static var rotationAllowed = false

  static func mask(for idiom: UIUserInterfaceIdiom) -> UIInterfaceOrientationMask {
    let declared = infoPlistMask(for: idiom)
    // iPad already declares every orientation.
    guard rotationAllowed, idiom == .phone else { return declared }
    return declared.union([.landscapeLeft, .landscapeRight])
  }

  static func setRotationAllowed(_ allowed: Bool) {
    guard allowed != rotationAllowed else { return }
    rotationAllowed = allowed
    let device = UIDevice.current
    if allowed {
      device.beginGeneratingDeviceOrientationNotifications()
    }
    // Opening turns the screen the way the phone is held; closing turns it
    // back upright. Turns in between follow the device.
    let target = allowed ? heldLandscape(device.orientation) : mask(for: device.userInterfaceIdiom)
    if !allowed {
      device.endGeneratingDeviceOrientationNotifications()
    }
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows {
        var controller = window.rootViewController
        while let current = controller {
          current.setNeedsUpdateOfSupportedInterfaceOrientations()
          controller = current.presentedViewController
        }
      }
      if let target {
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: target)) { _ in }
      }
    }
  }

  /// The interface orientation for a phone held sideways (the two are mirrored).
  private static func heldLandscape(_ orientation: UIDeviceOrientation) -> UIInterfaceOrientationMask? {
    switch orientation {
    case .landscapeLeft: return .landscapeRight
    case .landscapeRight: return .landscapeLeft
    default: return nil
    }
  }

  private static func infoPlistMask(for idiom: UIUserInterfaceIdiom) -> UIInterfaceOrientationMask {
    let info = Bundle.main.infoDictionary ?? [:]
    let pad = idiom == .pad ? parse(info["UISupportedInterfaceOrientations~ipad"]) : []
    let mask = pad.isEmpty ? parse(info["UISupportedInterfaceOrientations"]) : pad
    return mask.isEmpty ? .allButUpsideDown : mask
  }

  private static func parse(_ value: Any?) -> UIInterfaceOrientationMask {
    var mask: UIInterfaceOrientationMask = []
    for name in value as? [String] ?? [] {
      switch name {
      case "UIInterfaceOrientationPortrait": mask.insert(.portrait)
      case "UIInterfaceOrientationPortraitUpsideDown": mask.insert(.portraitUpsideDown)
      case "UIInterfaceOrientationLandscapeLeft": mask.insert(.landscapeLeft)
      case "UIInterfaceOrientationLandscapeRight": mask.insert(.landscapeRight)
      default: break
      }
    }
    return mask
  }
}

public final class T3PlayOrientationAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    MainActor.assumeIsolated {
      T3PlayOrientationPolicy.mask(for: UIDevice.current.userInterfaceIdiom)
    }
  }
}

public final class T3PlayOrientationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3PlayOrientation")

    Function("setRotationAllowed") { (allowed: Bool) in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          T3PlayOrientationPolicy.setRotationAllowed(allowed)
        }
      }
    }
  }
}
