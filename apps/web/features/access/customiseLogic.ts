/** The customise dialog's draft and rules, shared with the apps: see `@ruchoir/client/permissionsLogic`. */
export {
  type CustomiseKind as Kind,
  type State,
  type Draft,
  type LockReason,
  type Group,
  customiseGroupsOf as groupsOf,
  draftOf,
  stateOf,
  setState,
  ruleOf,
  changedCount,
  locksOf,
  canCustomise,
  resultOf,
  nextRadio,
} from "@ruchoir/client/permissionsLogic";
