//! Permissions: what a person may do in a space, decided in one place.
//!
//! The catalogue names every right ([`catalogue`]), the engine resolves them ([`engine`]) from
//! what the loader reads ([`load`]), and handlers ask [`check`]. [`changed`] tells a space that its
//! rights moved.

pub mod catalogue;
pub mod changed;
pub mod check;
pub mod delegation;
pub mod engine;
pub mod group_routes;
pub mod groups;
pub mod levels;
pub mod load;
pub mod membership;
pub mod preview;
pub mod roles;
pub mod rule_routes;
pub mod rules;
pub mod system_roles;
pub mod why;
