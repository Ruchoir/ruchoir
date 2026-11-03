//! Permissions: what a person may do in a space, decided in one place.
//!
//! The catalogue names every right ([`catalogue`]). Handlers are switched onto this module in the
//! second half of the foundation; until then nothing outside the tests calls it.

// Removed once the handlers call the engine (permissions lot 1, Task 10).
#![allow(dead_code)]

pub mod catalogue;
