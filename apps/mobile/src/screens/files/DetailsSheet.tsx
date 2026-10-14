import { fileExtension } from "@ruchoir/client";
import { useRoute, type RouteProp } from "@react-navigation/native";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { fileSize } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";

/** Everything the list leaves out of an entry (the web's details): kind, size, place, dates, version, source. */
export function DetailsSheet() {
  const { params } = useRoute<RouteProp<RootParams, "fileDetails">>();
  const { t } = useTranslation();
  const { locale, timeZone } = useLocale();
  const file = params.file;
  const folder = file.kind === "folder";
  const when = (iso?: string) =>
    iso ? new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null;
  const extension = fileExtension(file.name);
  const modified = when(file.updatedAt);
  return (
    <Sheet>
      <Text variant="heading">{file.name}</Text>
      <Line label={t("files.type")}>{folder ? t("files.typeFolder") : extension ? extension.toUpperCase() : (file.mimeType ?? "")}</Line>
      {!folder ? <Line label={t("files.size")}>{fileSize(file.sizeBytes, locale)}</Line> : null}
      <Line label={t("files.location")}>{params.path || t("files.root")}</Line>
      {file.createdAt ? <Line label={t("files.created")}>{when(file.createdAt)}</Line> : null}
      {modified ? (
        <Line label={t("files.modified")}>{file.modifiedBy ? t("files.modifiedOnBy", { when: modified, who: file.modifiedBy }) : modified}</Line>
      ) : null}
      {!folder && file.versionNo ? <Line label={t("files.version")}>{String(file.versionNo)}</Line> : null}
      {file.imported && file.source ? <Line label={t("files.source")}>{t("files.importedFrom", { source: file.source })}</Line> : null}
    </Sheet>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={[styles.line, { borderBottomColor: c.line }]}>
      <Text variant="small" tone="muted">
        {label}
      </Text>
      <Text variant="body">{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { gap: 2, paddingVertical: 10, borderBottomWidth: 1 },
});
