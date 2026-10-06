import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  playLinkWithTicket,
  sessionMayMintPlayTicket,
} from "@t3tools/client-runtime/polyzonia-play";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, StatusBar, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { WebView } from "react-native-webview";

import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { environmentSession, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { mintPlayTicketCommand, usePlayEnvironments } from "./playEnvironments";
import { setPlayRotationAllowed } from "./playOrientation";
import { resolvePlayRoute, type PlayRouteParams } from "./playRoute";

const BACKGROUND = "#000000";
/** How far in from the left edge a closing swipe may start, like the system back swipe. */
const EDGE_WIDTH = 24;
const CLOSE_DISTANCE = 96;
/** A deep link's environment may still be connecting when the screen opens. */
const ADDRESS_WAIT_MS = 10_000;
const SIGNED_OUT_MESSAGE = "t3-play:signed-out";

/**
 * Reports when the proxy's sign-in page gives up (its message changes from
 * "Signing in…"); a successful sign-in navigates away instead. Injected only
 * into pages the proxy answered 401, so the game never sees it.
 */
const WATCH_SIGN_IN_PAGE = `(function () {
  var message = document.getElementById("message");
  if (!message) return;
  var initial = "Signing in\\u2026";
  var report = function () {
    if (message.textContent !== initial) {
      window.ReactNativeWebView.postMessage(${JSON.stringify(SIGNED_OUT_MESSAGE)});
    }
  };
  report();
  new MutationObserver(report).observe(message, { childList: true, characterData: true, subtree: true });
})();
true;`;

type PlayRouteScreenProps = StaticScreenProps<PlayRouteParams>;

/**
 * Polyzonia play pages (fork-only): an edge-to-edge web view with no chrome.
 * A swipe in from the left edge closes it, so the game keeps every other touch.
 */
export function PlayRouteScreen({ route }: PlayRouteScreenProps) {
  const navigation = useNavigation();
  const close = useCallback(() => {
    setPlayRotationAllowed(false);
    navigation.goBack();
  }, [navigation]);

  useEffect(() => {
    setPlayRotationAllowed(true);
    return () => setPlayRotationAllowed(false);
  }, []);

  const environments = usePlayEnvironments();
  const [stillConnecting, setStillConnecting] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setStillConnecting(false), ADDRESS_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const state = resolvePlayRoute(route.params, environments, stillConnecting);
  const href = state.kind === "open" ? state.url.toString() : null;
  const environmentId = state.kind === "open" ? state.environmentId : null;

  return (
    <GestureHandlerRootView style={styles.fill}>
      <StatusBar hidden animated />
      <EdgeSwipeToClose onClose={close}>
        {href !== null && environmentId !== null ? (
          <PlayWebView key={href} environmentId={environmentId} href={href} onClose={close} />
        ) : state.kind === "waiting" ? (
          <PlayNotice busy />
        ) : (
          <PlayNotice
            message="This link is not a play page of an environment this app is paired with."
            onClose={close}
          />
        )}
      </EdgeSwipeToClose>
    </GestureHandlerRootView>
  );
}

function PlayWebView(props: {
  readonly environmentId: EnvironmentId;
  readonly href: string;
  readonly onClose: () => void;
}) {
  const link = useMemo(() => new URL(props.href), [props.href]);
  const webView = useRef<WebView<object>>(null);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  // The page loaded now, and a remount key for retries and lost web processes.
  const [page, setPage] = useState({ uri: props.href, attempt: 0 });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const lastStatus = useRef(200);

  // A link's own ticket is redeemed by the page. Without one, or once it is
  // spent, the app signs the view in with a ticket from its own session, once.
  const prepared = usePreparedConnection(props.environmentId);
  const session = useAtomValue(environmentSession.sessionStateValueAtom(props.environmentId));
  const mint = useAtomCommand(mintPlayTicketCommand, { reportFailure: false });
  const [signedOut, setSignedOut] = useState(false);
  const minted = useRef(false);
  useEffect(() => {
    if (!signedOut || minted.current || Option.isNone(prepared)) return;
    if (!sessionMayMintPlayTicket(session)) return;
    minted.current = true;
    void mint(prepared.value).then((result) => {
      // On failure the page keeps its own sign-in prompt.
      if (!active.current || result._tag !== "Success") return;
      setPage((current) => ({
        uri: playLinkWithTicket(link, result.value.ticket),
        attempt: current.attempt + 1,
      }));
    });
  }, [link, mint, prepared, session, signedOut]);

  const reload = () => {
    setFailure(null);
    setLoading(true);
    setPage((current) => ({ ...current, attempt: current.attempt + 1 }));
  };

  return (
    <View style={styles.fill}>
      <WebView<object>
        key={page.attempt}
        ref={webView}
        source={{ uri: page.uri }}
        style={styles.webView}
        containerStyle={styles.fill}
        // Edge to edge: the page lays itself out with viewport-fit=cover and
        // env(safe-area-inset-*), and nothing scrolls or bounces but the game.
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowsBackForwardNavigationGestures={false}
        allowsLinkPreview={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        // The game raises the keyboard by focusing a hidden input.
        keyboardDisplayRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled
        // The default (persistent) store keeps the play cookie and the game's saves.
        incognito={false}
        setSupportMultipleWindows={false}
        // Safari's Develop menu can inspect the game.
        webviewDebuggingEnabled
        onLoadStart={() => {
          lastStatus.current = 200;
        }}
        onHttpError={(event) => {
          lastStatus.current = event.nativeEvent.statusCode;
        }}
        onLoadEnd={() => {
          setLoading(false);
          if (lastStatus.current === 401) webView.current?.injectJavaScript(WATCH_SIGN_IN_PAGE);
        }}
        onMessage={(event) => {
          if (event.nativeEvent.data === SIGNED_OUT_MESSAGE) setSignedOut(true);
        }}
        onError={(event) => {
          setLoading(false);
          setFailure(event.nativeEvent.description || "The game could not be loaded.");
        }}
        onContentProcessDidTerminate={reload}
        onRenderProcessGone={reload}
        onShouldStartLoadWithRequest={(request) => {
          if (request.isTopFrame === false || isPlayNavigation(request.url, link.origin)) {
            return true;
          }
          // Links out of the game go to the system browser.
          void Linking.openURL(request.url).catch(() => undefined);
          return false;
        }}
      />
      {failure !== null ? (
        <PlayNotice message={failure} onRetry={reload} onClose={props.onClose} />
      ) : loading ? (
        <PlayNotice busy />
      ) : null}
    </View>
  );
}

/** The play origin's pages, and documents a page makes itself. */
function isPlayNavigation(url: string, origin: string): boolean {
  if (/^(?:about|blob|data):/i.test(url)) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function PlayNotice(props: {
  readonly busy?: boolean;
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly onClose?: () => void;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.notice]}>
      {props.busy ? <ActivityIndicator color="#ffffff" /> : null}
      {props.message ? (
        <AppText selectable className="text-center text-sm" style={styles.noticeText}>
          {props.message}
        </AppText>
      ) : null}
      <View style={styles.noticeActions}>
        {props.onRetry ? <NoticeButton label="Try again" onPress={props.onRetry} /> : null}
        {props.onClose ? <NoticeButton label="Close" onPress={props.onClose} /> : null}
      </View>
    </View>
  );
}

function NoticeButton(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" style={styles.noticeButton} onPress={props.onPress}>
      <AppText style={styles.noticeText}>{props.label}</AppText>
    </Pressable>
  );
}

/**
 * Closes on a rightward swipe that starts within EDGE_WIDTH of the left edge.
 * The recognizer sits on a view around the web view, outside the page's touch
 * handling, and cancels the page's touches once it takes over.
 */
function EdgeSwipeToClose(props: { readonly onClose: () => void; readonly children: ReactNode }) {
  const travel = useSharedValue(0);
  const { onClose } = props;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 0, width: EDGE_WIDTH })
        .activeOffsetX(12)
        .failOffsetX(-12)
        .failOffsetY([-40, 40])
        .onUpdate((event) => {
          travel.set(Math.max(0, event.translationX));
        })
        .onEnd((event) => {
          if (event.translationX > CLOSE_DISTANCE || event.velocityX > 800) runOnJS(onClose)();
        })
        .onFinalize(() => {
          travel.set(withTiming(0, { duration: 150 }));
        }),
    [onClose, travel],
  );
  const hintStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, travel.get() / CLOSE_DISTANCE),
    transform: [{ translateX: Math.min(travel.get(), CLOSE_DISTANCE) / 2 }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill} collapsable={false}>
        {props.children}
        <Animated.View pointerEvents="none" style={[styles.hint, hintStyle]}>
          <SymbolView name="chevron.left" size={18} tintColor="#ffffff" />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: BACKGROUND },
  webView: { flex: 1, backgroundColor: BACKGROUND },
  notice: {
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 32,
    backgroundColor: BACKGROUND,
  },
  noticeText: { color: "#ffffff" },
  noticeActions: { flexDirection: "row", gap: 12 },
  noticeButton: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.4)",
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  hint: {
    position: "absolute",
    left: 8,
    top: "50%",
    width: 36,
    height: 36,
    marginTop: -18,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
});
