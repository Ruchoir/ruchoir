/**
 * Opens the duplicate question (`ConflictSheet`) when a file the server refused as a duplicate starts
 * asking, wherever the person is by then: the file went in the background, after its sheet closed.
 */
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { useEffect } from "react";

import { nextQuestion } from "../logic/uploadQueue";
import type { RootParams } from "../navigation/types";
import { useUploads } from "./UploadsProvider";

/** Long enough for the sheet the file was picked from to finish closing. */
const AFTER_CLOSING_MS = 450;

export function useDuplicateQuestions(navigation: NavigationContainerRefWithCurrent<RootParams>): void {
  const asking = nextQuestion(useUploads().queue)?.key;
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => {
      if (navigation.isReady() && navigation.getCurrentRoute()?.name !== "uploadConflict") navigation.navigate("uploadConflict");
    }, AFTER_CLOSING_MS);
    return () => clearTimeout(timer);
  }, [asking, navigation]);
}
