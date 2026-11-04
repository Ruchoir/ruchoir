/**
 * Installing a licence (mockup frame 13, middle and right): Coller (a text field, with a button that
 * pastes the clipboard) or Choisir un fichier (the phone's document picker: .txt, .lic or .licence,
 * read as text). Whatever the way, the text is checked on the phone first (`logic/licenceFile.ts`:
 * type, 64 Ko, empty, not text) and every refusal of the server has its own sentence, shown under the
 * field. Installed, the screen goes back with a toast.
 *
 * `expo-document-picker`, `expo-file-system` and `expo-clipboard` are all in Expo Go.
 */
import { refusalOf } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { ClipboardPaste, FileText, Upload, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLocale } from "../../i18n/useLocale";
import { key, useTranslation, type DictKey } from "../../i18n";
import { checkLicence, knownFileSize, type LicenceProblem } from "../../logic/licenceFile";
import { fileSize } from "../../logic/format";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { Segmented } from "../../ui/Segmented";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { TextField } from "../../ui/TextField";

/** How every licence begins: the field's example, the same in every language. */
const LICENCE_PREFIX = "RUCHOIR-LICENCE-1.";

type Mode = "paste" | "file";

/** The picked file, already read and checked. */
type Picked = { name: string; size: number; text: string };

const PROBLEM_KEY = {
  type: key("licence.file.type"),
  size: key("licence.file.size"),
  empty: key("licence.file.empty"),
  notText: key("licence.file.notText"),
} as const satisfies Record<LicenceProblem, DictKey>;

export function LicenceInstallScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("licence");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={useTranslation().t("licence.installTitle")} subtitle={current?.name} />
      {current ? <Install spaceId={current.id} /> : null}
    </SafeAreaView>
  );
}

function Install({ spaceId }: { spaceId: string }) {
  const { putLicence } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const { spaces } = useSpace();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const change = (next: Mode) => {
    setMode(next);
    setError(undefined);
  };

  const pasteClipboard = async () => {
    const copied = await Clipboard.getStringAsync();
    if (!copied.trim()) {
      toast(t("licence.clipboardEmpty"), "failure");
      return;
    }
    setText(copied.trim());
    setError(undefined);
  };

  const pickFile = async () => {
    setError(undefined);
    const result = await DocumentPicker.getDocumentAsync({ type: ["text/plain", "application/octet-stream", "*/*"], copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setPicked(null);
    try {
      const file = new File(asset.uri);
      const size = knownFileSize(asset.size, file.size);
      // Type and size first: a photo or a huge file is never read as text, and a file whose size
      // nobody can tell is not read at all (it could be of any size).
      const early = size === null ? "size" : checkLicence({ name: asset.name, mime: asset.mimeType, size, text: "x" });
      if (size === null || early === "type" || early === "size") {
        setError(t(PROBLEM_KEY[early ?? "size"]));
        return;
      }
      const read = await file.text();
      const problem = checkLicence({ name: asset.name, mime: asset.mimeType, size, text: read });
      if (problem) {
        setError(t(PROBLEM_KEY[problem]));
        return;
      }
      setPicked({ name: asset.name, size, text: read.trim() });
    } catch {
      setError(t("licence.file.unreadable"));
    }
  };

  const toSend = mode === "paste" ? text.trim() : (picked?.text ?? "");

  const install = async () => {
    const problem = checkLicence({ text: toSend });
    if (problem) {
      setError(t(problem === "empty" ? key("licence.textEmpty") : PROBLEM_KEY[problem]));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const installed = await putLicence(spaceId, toSend);
      feel("success");
      toast(`${t("licence.installed")} · ${installed.organisation}`, "success");
      spaces.reload();
      navigation.goBack();
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      setError(said ? String(t(said.key as never, said.vars as never)) : t("licence.installFailed"));
      feel("failure");
      setBusy(false);
    }
  };

  return (
    <KeyboardForm
      contentContainerStyle={styles.content}
      footer={
        <View style={styles.footer}>
          <Button label={t("licence.install")} onPress={() => void install()} busy={busy} disabled={toSend === ""} />
        </View>
      }
    >
      <Segmented<Mode>
        options={[
          { key: "paste", label: t("invitation.paste") },
          { key: "file", label: t("licence.pickFile") },
        ]}
        value={mode}
        onChange={change}
      />
      {mode === "paste" ? (
        <>
          <TextField
            label={t("licence.pasteLabel")}
            value={text}
            onChangeText={(next) => {
              setText(next);
              setError(undefined);
            }}
            multiline
            minHeight={150}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder={LICENCE_PREFIX}
          />
          {error ? <Banner tone="danger" text={error} /> : null}
          <Button
            label={t("licence.pasteFromClipboard")}
            variant="secondary"
            size="md"
            icon={<ClipboardPaste size={18} color={c.ink} />}
            onPress={() => void pasteClipboard()}
          />
        </>
      ) : (
        <>
          <Text variant="smallStrong">{t("licence.pasteLabel")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("licence.pickFile")}
            onPress={() => void pickFile()}
            style={[styles.drop, { borderColor: c.lineStrong }]}
          >
            <Upload size={26} color={c.ink} />
            <Text variant="bodyStrong">{t("licence.pickFile")}</Text>
            <Text variant="tiny" tone="muted">
              {t("licence.pickHint")}
            </Text>
          </Pressable>
          {error ? <Banner tone="danger" text={error} /> : null}
          {picked ? (
            <View style={styles.picked}>
              <View style={[styles.tile, { backgroundColor: c.sky }]}>
                <FileText size={20} color={c.onPastel} />
              </View>
              <View style={styles.pickedText}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {picked.name}
                </Text>
                <Text variant="tiny" tone="muted">
                  {fileSize(picked.size, locale)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("licence.removeFile")}
                hitSlop={8}
                onPress={() => {
                  setPicked(null);
                  setError(undefined);
                }}
              >
                <X size={20} color={s.edge} />
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </KeyboardForm>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    content: { padding: 16, gap: 14, paddingBottom: 24 },
    footer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
    drop: { alignItems: "center", gap: 4, paddingVertical: 28, borderWidth: shape.hairline, borderStyle: "dashed", borderRadius: shape.radius.l },
    picked: { flexDirection: "row", alignItems: "center", gap: 12 },
    tile: { width: 40, height: 40, borderRadius: shape.radius.m, alignItems: "center", justifyContent: "center" },
    pickedText: { flex: 1, minWidth: 0 },
  }),
);
