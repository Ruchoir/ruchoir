//! Server-side image thumbnailing.
//!
//! Image uploads are decoded to read their intrinsic dimensions and to produce a downscaled JPEG
//! thumbnail (aspect ratio preserved) stored as a second object. Decoding is limited to the web
//! formats the crate is built with (JPEG, PNG, GIF, WebP); anything else fails and the upload keeps
//! its bytes without a thumbnail.

use std::io::Cursor;

use image::{GenericImageView, ImageFormat};

/// The MIME type generated thumbnails are stored and served with.
pub const THUMBNAIL_MIME: &str = "image/jpeg";

/// The result of inspecting an uploaded image.
pub struct ImageInfo {
    /// Intrinsic width of the original image, in pixels.
    pub width: u32,
    /// Intrinsic height of the original image, in pixels.
    pub height: u32,
    /// Encoded JPEG bytes of the thumbnail.
    pub thumbnail: Vec<u8>,
}

/// Decode `bytes` as an image and produce its dimensions plus a thumbnail whose longest edge is at
/// most `max_px`. Returns an error for unsupported or corrupt image data.
pub fn make_thumbnail(bytes: &[u8], max_px: u32) -> Result<ImageInfo, image::ImageError> {
    let image = image::load_from_memory(bytes)?;
    let (width, height) = image.dimensions();

    // Downscale only: `thumbnail` bounds the longest edge to `max_px` but would UPSCALE a smaller
    // image, so skip it when the source already fits (a thumbnail must never exceed the original).
    // `thumbnail` preserves the aspect ratio and is fast.
    let scaled = if width > max_px || height > max_px {
        image.thumbnail(max_px, max_px)
    } else {
        image
    };
    let mut encoded = Vec::new();
    flatten_onto_white(&scaled).write_to(&mut Cursor::new(&mut encoded), ImageFormat::Jpeg)?;

    Ok(ImageInfo {
        width,
        height,
        thumbnail: encoded,
    })
}

/// Decode an image, keep its largest centred square, bound it to `max_px` and encode it as JPEG.
///
/// For avatars and space icons, which are only ever displayed in a square. Cropping here rather than
/// leaving it to CSS means the stored image is exactly what will be shown, whatever arrived: a client
/// that skipped its own cropping step, an older client, or a direct call to the API. The client's
/// crop is the one that decides *which* square; this one only guarantees that there is one.
pub fn square(bytes: &[u8], max_px: u32) -> Result<SquareImage, image::ImageError> {
    let image = image::load_from_memory(bytes)?;
    let (width, height) = image.dimensions();
    let side = width.min(height);
    let cropped = image.crop_imm((width - side) / 2, (height - side) / 2, side, side);

    // Downscale only, never up: a small avatar stays small rather than being blown up into blur.
    let scaled = if side > max_px {
        cropped.thumbnail(max_px, max_px)
    } else {
        cropped
    };

    // Transparency is kept here, unlike for document thumbnails: a space icon is very often a logo on
    // a transparent background, and flattening it would paint a rectangle behind a mark that is meant
    // to sit on the rail's own colour. JPEG cannot carry alpha at all, so an image that has any is
    // encoded as PNG instead; one that has none stays JPEG, which is far smaller for a photo.
    let mut bytes = Vec::new();
    if scaled.color().has_alpha() {
        image::DynamicImage::ImageRgba8(scaled.to_rgba8())
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)?;
        Ok(SquareImage {
            bytes,
            mime: "image/png",
            extension: "png",
        })
    } else {
        image::DynamicImage::ImageRgb8(scaled.to_rgb8())
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)?;
        Ok(SquareImage {
            bytes,
            mime: THUMBNAIL_MIME,
            extension: "jpg",
        })
    }
}

/// A normalised square image, with the format it had to be encoded in.
pub struct SquareImage {
    pub bytes: Vec<u8>,
    /// Content type to serve it with.
    pub mime: &'static str,
    /// File extension, recorded in the object key so serving can derive the type back.
    pub extension: &'static str,
}

/// Composite an image over white before dropping its alpha channel.
///
/// Flattening straight to RGB leaves transparent pixels black, which turned every transparent PNG
/// thumbnail into a picture on a black rectangle. White is the neutral choice for a preview shown on
/// a light surface.
fn flatten_onto_white(image: &image::DynamicImage) -> image::DynamicImage {
    if !image.color().has_alpha() {
        return image::DynamicImage::ImageRgb8(image.to_rgb8());
    }
    let source = image.to_rgba8();
    let mut flat = image::RgbImage::new(source.width(), source.height());
    for (x, y, pixel) in source.enumerate_pixels() {
        let alpha = f32::from(pixel[3]) / 255.0;
        let over =
            |channel: u8| ((f32::from(channel) * alpha) + 255.0 * (1.0 - alpha)).round() as u8;
        flat.put_pixel(
            x,
            y,
            image::Rgb([over(pixel[0]), over(pixel[1]), over(pixel[2])]),
        );
    }
    image::DynamicImage::ImageRgb8(flat)
}
