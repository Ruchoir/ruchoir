/** Roles, permission rows and who may do what with them, shared with the apps: see `@ruchoir/client/permissionsLogic`. */
export {
  type RoleLike,
  FAMILIES,
  GUEST_CEILING_SET as GUEST_CEILING,
  permissionRow,
  changedPermissions,
  orderAllowed,
  type MemberAccess,
  type RoleChoice,
  memberAccessFor,
  roleIdsToSave,
  LEGACY_ROLES,
  grantableRoles,
  type RoleRowState,
  roleRowState,
  holdsEverything,
} from "@ruchoir/client/permissionsLogic";
