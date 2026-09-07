//! S3-compatible object store wrapper around `rust-s3`.
//!
//! Talks the S3 API (Garage by default) with path-style addressing, which Garage and MinIO require.
//! In development it speaks plaintext HTTP over the trusted Docker network, the same posture as
//! PostgreSQL and Valkey; the `rust-s3` dependency is deliberately built without any TLS backend so
//! no non-sovereign crypto library enters the tree (TLS-to-store is a later hardening step). Only
//! opaque, server-generated keys ever reach this layer: a user-supplied filename never becomes part
//! of an object key.

use std::fmt;

use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::error::S3Error;
use s3::region::Region;

use crate::config::Config;

/// A handle to the configured object store bucket.
pub struct S3Store {
    bucket: Box<Bucket>,
}

impl S3Store {
    /// Build the store from configuration. Fails only on invalid credentials or an unparseable
    /// endpoint; it does not touch the network here (a bad endpoint surfaces on the first request).
    pub fn from_config(config: &Config) -> Result<Self, StorageError> {
        let access = config
            .s3_access_key
            .as_deref()
            .ok_or_else(|| StorageError::Config("missing S3 access key".to_owned()))?;
        let secret = config
            .s3_secret_key
            .as_deref()
            .ok_or_else(|| StorageError::Config("missing S3 secret key".to_owned()))?;

        let credentials = Credentials::new(Some(access), Some(secret), None, None, None)
            .map_err(|err| StorageError::Config(err.to_string()))?;
        let region = Region::Custom {
            region: config.s3_region.clone(),
            endpoint: config.s3_endpoint.clone(),
        };

        // Path-style addressing (`endpoint/bucket/key`) instead of the virtual-host style AWS uses,
        // because Garage and MinIO are addressed by path.
        let bucket = Bucket::new(&config.s3_bucket, region, credentials)
            .map_err(StorageError::Backend)?
            .with_path_style();

        Ok(Self { bucket })
    }

    /// Store an object under `key` with the given content type, replacing any existing object.
    pub async fn put(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<(), StorageError> {
        self.bucket
            .put_object_with_content_type(key, bytes, content_type)
            .await?;
        Ok(())
    }

    /// Fetch an object's bytes. The size is bounded upstream by the upload cap, so buffering the
    /// whole object is acceptable for the MVP (streaming back is a later optimization).
    pub async fn get(&self, key: &str) -> Result<Vec<u8>, StorageError> {
        let response = self.bucket.get_object(key).await?;
        Ok(response.bytes().to_vec())
    }

    /// Ask the backend whether it is reachable and the bucket is usable.
    ///
    /// Run once at startup, so a store that is configured but not set up says so there rather than
    /// at the first upload, where it surfaces as a 502 on someone's file. Listing with a limit of
    /// one is the cheapest request that exercises credentials, the bucket and the grant at once; an
    /// empty bucket answers it successfully, which is the state a fresh install is in.
    pub async fn probe(&self) -> Result<(), StorageError> {
        self.bucket
            .list_page("".to_owned(), None, None, None, Some(1))
            .await?;
        Ok(())
    }

    /// Delete an object. Missing objects are not an error for the caller's purposes; the backend
    /// reports success for an absent key under S3 delete semantics. Part of the store surface for
    /// hard-delete / garbage collection (soft-delete keeps object bytes, so it is not called yet).
    #[allow(dead_code)]
    pub async fn delete(&self, key: &str) -> Result<(), StorageError> {
        self.bucket.delete_object(key).await?;
        Ok(())
    }
}

/// Errors from the object-storage layer.
#[derive(Debug)]
pub enum StorageError {
    /// The store could not be configured (bad or missing credentials/endpoint).
    Config(String),
    /// The backend request failed.
    Backend(S3Error),
}

impl From<S3Error> for StorageError {
    fn from(err: S3Error) -> Self {
        StorageError::Backend(err)
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageError::Config(message) => write!(f, "object store configuration: {message}"),
            StorageError::Backend(err) => write!(f, "object store backend error: {err}"),
        }
    }
}

impl std::error::Error for StorageError {}
