/**
 * expo-notifications and expo-task-manager, loaded only in the real app (ADR 0006). Expo Go carries
 * no push module for this app, and loading expo-notifications there throws at once ("Cannot find
 * native module 'ExpoPushTokenManager'"), which took the whole app down at launch: every other file
 * reaches them through here, and gets null in Expo Go.
 */
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";

type NotificationsModule = typeof import("expo-notifications");
type TaskManagerModule = typeof import("expo-task-manager");

/** Whether this app can receive pushes here: a real build, not Expo Go, not the web. */
export function phonePushAvailable(): boolean {
  return Platform.OS !== "web" && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

let notificationsModule: NotificationsModule | null | undefined;
let taskManagerModule: TaskManagerModule | null | undefined;

export function notifications(): NotificationsModule | null {
  if (notificationsModule === undefined) {
    // Required here rather than imported, for the reason above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notificationsModule = phonePushAvailable() ? (require("expo-notifications") as NotificationsModule) : null;
  }
  return notificationsModule;
}

export function taskManager(): TaskManagerModule | null {
  if (taskManagerModule === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    taskManagerModule = phonePushAvailable() ? (require("expo-task-manager") as TaskManagerModule) : null;
  }
  return taskManagerModule;
}
