/**
 * What an instance can do beyond every `/api/v1` instance (`GET /instance`, `features`), read once
 * per client and kept while it lives. Unknown (no answer yet, or an older instance) reads as "no":
 * whatever needs it is simply not offered (docs/api-compatibility.md).
 */
import type { RuchoirClient } from "@ruchoir/client";
import { useEffect, useState } from "react";

import { featureState } from "../logic/featureState";
import { useApi } from "./useApi";

const features = new WeakMap<RuchoirClient, Promise<readonly string[]>>();

function featuresOf(api: RuchoirClient): Promise<readonly string[]> {
  let found = features.get(api);
  if (!found) {
    found = api.getInstanceCapabilities().then(
      (caps) => caps.features,
      () => {
        features.delete(api);
        return [];
      },
    );
    features.set(api, found);
  }
  return found;
}

/** Feature sets already answered, so a remount reads them at once instead of starting from "unknown". */
const settled = new WeakMap<RuchoirClient, readonly string[]>();

/** What the instance on screen offers: undefined until it has said so, then the list (empty if unreachable). */
export function useFeatures(): readonly string[] | undefined {
  const api = useApi();
  const [answer, setAnswer] = useState<{ api: RuchoirClient; list: readonly string[] }>();
  useEffect(() => {
    if (settled.has(api)) return;
    let alive = true;
    void featuresOf(api).then((list) => {
      if (!alive) return;
      // An unreachable answer is not remembered (featuresOf forgot it): the next mount asks again.
      if (features.has(api)) settled.set(api, list);
      setAnswer({ api, list });
    });
    return () => {
      alive = false;
    };
  }, [api]);
  // Read at render: a remount on a client that already answered starts known, with no "unknown" frame.
  return settled.get(api) ?? (answer?.api === api ? answer.list : undefined);
}

/** Whether the instance on screen has `feature`: undefined while it has not said, then true or false. */
export function useFeature(feature: string): boolean | undefined {
  return featureState(useFeatures(), feature);
}

/** Whether the instance on screen has `feature`; false until it has said so. */
export function useSupports(feature: string): boolean {
  return useFeature(feature) === true;
}
