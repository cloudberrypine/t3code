import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Local: native desktop notifications when an agent finishes a turn or asks a question. */
export function AgentNotificationsSetting() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const enabled = useScopedSettings((settings) => settings.desktopCompletionNotificationsEnabled);
  const updateSettings = useUpdateScopedSettings();
  const defaultEnabled = DEFAULT_UNIFIED_SETTINGS.desktopCompletionNotificationsEnabled;

  return (
    <SettingsRow
      {...setting("completion-notifications")}
      description={gt(
        "Show a native notification when an agent finishes a turn or asks a question, including while it keeps working. Click it to open the thread.",
      )}
      resetAction={
        enabled !== defaultEnabled ? (
          <SettingResetButton
            ariaLabel={gt("Reset agent notifications to default")}
            onClick={() =>
              updateSettings({ desktopCompletionNotificationsEnabled: defaultEnabled })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ desktopCompletionNotificationsEnabled: Boolean(checked) })
          }
          aria-label={gt("Agent notifications")}
        />
      }
    />
  );
}
