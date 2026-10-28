/**
 * What an instance can do beyond every `/api/v1` instance (`GET /instance`, `features`), read once
 * per client and kept while it lives. Unknown (no answer yet, or an older instance) reads as "no":
 * whatever needs it is simply not offered (docs/api-compatibility.md).
 */
import { supports, type RuchoirClient } from "@ruchoir/client";
import { useEffect, useState } from "react";

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

/** Whether the instance on screen has `feature`; false until it has said so. */
export function useSupports(feature: string): boolean {
  const api = useApi();
  const [has, setHas] = useState(false);
  useEffect(() => {
    let alive = true;
    void featuresOf(api).then((list) => {
      if (alive) setHas(supports({ features: [...list] }, feature));
    });
    return () => {
      alive = false;
    };
  }, [api, feature]);
  return has;
}
