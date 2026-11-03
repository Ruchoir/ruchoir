//! The community build of the Ruchoir API: the library run as [`CommunityEdition`].

use std::process::ExitCode;
use std::sync::Arc;

use ruchoir_api::edition::CommunityEdition;

#[tokio::main]
async fn main() -> ExitCode {
    ruchoir_api::run(Arc::new(CommunityEdition)).await
}
