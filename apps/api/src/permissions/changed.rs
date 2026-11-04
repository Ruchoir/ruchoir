//! Telling a space that what its people may do has changed.
//!
//! Any change of a role, a standing or a rule publishes `permissions.changed { space_id }` to the
//! space's members, after the write is committed. The event carries no rights: each client asks the
//! server again what it may do, so nobody learns anything about anyone else from it.

use uuid::Uuid;

use super::membership;
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

/// Publish `permissions.changed` to every member of the space. Best effort: the change is already
/// committed, and a client that missed the event still gets the truth on its next request.
pub async fn announce(state: &AppState, space_id: Uuid) {
    let audience = match membership::active_ids(&state.db, space_id).await {
        Ok(members) => members,
        Err(error) => {
            tracing::warn!(%space_id, %error, "permissions.changed not announced");
            return;
        }
    };
    state
        .hub
        .publish(audience, RealtimeEnvelope::permissions_changed(space_id))
        .await;
}
