import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Check, Globe } from "lucide-react-native";
import { useMemo, useState } from "react";
import { StyleSheet } from "react-native";

import { useTranslation } from "../../i18n";
import { allTimeZones } from "../../logic/timeZones";
import type { RootParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { SearchField } from "../../ui/SearchField";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { choose } from "./choice";

/** How many zones the list shows at once: a search narrows the four hundred down. */
const SHOWN = 60;

/** A time zone, searched among the phone's list, handed back to the form that asked (`choice.ts`). */
export function ZonePicker() {
  const { params } = useRoute<RouteProp<RootParams, "zonePicker">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const [query, setQuery] = useState("");
  const zones = useMemo(() => allTimeZones(), []);
  const all = [...new Set([params.current, ...zones])];
  const q = query.trim().toLowerCase().replace(/\s+/g, "_");
  const shown = (q ? all.filter((z) => z.toLowerCase().includes(q)) : all).slice(0, SHOWN);
  return (
    <Sheet>
      <Text variant="heading">{t("eventForm.timeZone")}</Text>
      <SearchField value={query} onChange={setQuery} placeholder={t("eventForm.searchZone")} style={styles.search} />
      {shown.map((zone) => (
        <ActionRow
          key={zone}
          icon={Globe}
          tint={c.sky}
          title={zone.replace(/_/g, " ")}
          selected={zone === params.current}
          trailing={zone === params.current ? <Check size={20} color={c.ink} /> : undefined}
          onPress={() => {
            choose(params.key, zone);
            navigation.goBack();
          }}
        />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  search: { marginHorizontal: 0, marginVertical: 6 },
});
