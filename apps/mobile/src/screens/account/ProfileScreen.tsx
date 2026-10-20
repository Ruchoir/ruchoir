import type { Profile } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as ImagePicker from "expo-image-picker";
import { Globe } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { LoadState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { useChoice } from "./choice";

/** The phone's own zone, offered when the account has none. */
const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Form = { name: string; title: string; pronouns: string; bio: string; zone: string };

const formOf = (p: Profile): Form => ({
  name: p.name,
  title: p.role ?? "",
  pronouns: p.pronouns ?? "",
  bio: p.bio ?? "",
  zone: p.timezone ?? DEVICE_ZONE,
});

/**
 * My profile: the photo (square, cropped on the phone), the name, what they do, pronouns, a few words
 * about them and their time zone, as the web's profile panel. The photo goes as soon as it is chosen;
 * the rest with "Save".
 */
export function ProfileScreen() {
  const { clearMyAvatar, getUserProfile, setMyAvatar, updateMyProfile } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const me = session.state.kind === "signedIn" ? session.state.user : null;
  const profile = useLoad(me ? `profile:${me.id}` : null, (signal) => getUserProfile(me!.id, signal));
  const [form, setForm] = useState<Form | null>(null);
  const [avatar, setAvatar] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // The form opens on what the server holds, once.
  if (profile.data && !form) {
    setForm(formOf(profile.data));
    setAvatar(profile.data.avatarUrl);
  }
  useChoice("profileZone", (zone) => setForm((f) => (f ? { ...f, zone } : f)));

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    setPhotoBusy(true);
    try {
      const url = await setMyAvatar({ uri: asset.uri, name: "avatar.jpg", type: asset.mimeType ?? "image/jpeg" });
      setAvatar(url);
      session.updateUser({ avatarUrl: url });
    } catch {
      toast(t("profile.photoFailed"), "failure");
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      await clearMyAvatar();
      setAvatar(undefined);
      session.updateUser({ avatarUrl: undefined });
    } catch {
      toast(t("profile.photoFailed"), "failure");
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await updateMyProfile({
        displayName: form.name.trim(),
        title: form.title.trim(),
        pronouns: form.pronouns.trim(),
        bio: form.bio.trim(),
        timezone: form.zone,
      });
      session.updateUser({ name: saved.name, timezone: saved.timezone });
      toast(t("profile.saved"), "success");
      navigation.goBack();
    } catch {
      feel("failure");
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          form ? (
            <View style={styles.footer}>
              {failed ? <Banner tone="danger" text={t("profile.saveFailed")} /> : null}
              <Button label={t("compose.save")} onPress={() => void save()} busy={busy} disabled={!form.name.trim()} />
            </View>
          ) : null
        }
      >
        <SheetHeader title={t("account.profile")} onClose={() => navigation.goBack()} />
        {!form ? (
          <LoadState error={profile.error} onRetry={profile.reload} />
        ) : (
          <View style={styles.pad}>
            <View style={styles.photo}>
              <Avatar name={form.name || me?.name || "?"} src={avatar} size={88} />
              <View style={styles.photoActions}>
                <Button variant="secondary" size="sm" label={t("profile.changePhoto")} onPress={() => void pickPhoto()} busy={photoBusy} />
                {avatar ? <Button variant="ghost" size="sm" label={t("profile.removePhoto")} onPress={() => void removePhoto()} /> : null}
              </View>
            </View>
            <TextField label={t("signUp.name")} value={form.name} onChangeText={(name) => set({ name })} textContentType="name" />
            <TextField
              label={t("profile.title")}
              placeholder={t("profile.titlePlaceholder")}
              value={form.title}
              onChangeText={(title) => set({ title })}
              textContentType="jobTitle"
            />
            <TextField
              label={t("profile.pronouns")}
              placeholder={t("profile.pronounsPlaceholder")}
              value={form.pronouns}
              onChangeText={(pronouns) => set({ pronouns })}
              autoCapitalize="none"
            />
            <TextField
              label={t("profile.bio")}
              placeholder={t("profile.bioPlaceholder")}
              value={form.bio}
              onChangeText={(bio) => set({ bio })}
              multiline
            />
            <ActionRow
              icon={Globe}
              tint={c.sky}
              title={form.zone.replace(/_/g, " ")}
              subtitle={t("eventForm.timeZone")}
              onPress={() => navigation.navigate("zonePicker", { key: "profileZone", current: form.zone })}
            />
          </View>
        )}
      </KeyboardForm>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 24 },
  pad: { paddingHorizontal: 20, gap: 16 },
  photo: { flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 4 },
  photoActions: { flex: 1, alignItems: "flex-start", gap: 4 },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 10 },
});
