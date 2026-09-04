import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand, 
  DeleteObjectCommand 
} from "@aws-sdk/client-s3";
import sharp from "sharp";

const s3Client = new S3Client({});

// Allowed formats mapping
const ALLOWED_FORMATS = ["jpeg", "jpg", "png", "webp", "avif"];

export const handler = async (event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    let destKey = null;
    let inputBuffer = null;
    let originalContentType = "application/octet-stream";

    try {
      // 1. Fetch source image and metadata from S3
      const getObjResponse = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: sourceKey,
        })
      );

      const metadata = getObjResponse.Metadata || {};
      destKey = metadata.key;

      if (!destKey) {
        console.warn(`Skipping ${sourceKey}: missing required 'key' metadata field.`);
        continue;
      }

      originalContentType = getObjResponse.ContentType || originalContentType;
      const byteArray = await getObjResponse.Body.transformToByteArray();
      inputBuffer = Buffer.from(byteArray);

      // Initialize sharp and read original image metadata
      let pipeline = sharp(inputBuffer);
      const imageMetadata = await pipeline.metadata();
      const originalFormat = imageMetadata.format || "jpeg";

      // 2. Parse Transformation Metadata safely
      const crop = parseJsonMetadata(metadata.crop);
      const scale = parseJsonMetadata(metadata.scale);
      const formatData = parseJsonMetadata(metadata.format);
      const compressData = parseJsonMetadata(metadata.compress);

      // 3. Apply Crop
      if (crop?.width > 0 && crop?.height > 0) {
        pipeline = pipeline.resize({
          width: Number(crop.width),
          height: Number(crop.height),
          fit: "cover",
          position: "center",
        });
      }

      // 4. Apply Scale
      if (scale?.width > 0 && scale?.height > 0) {
        pipeline = pipeline.resize({
          width: Number(scale.width),
          height: Number(scale.height),
          fit: "fill", 
        });
      }

      // 5. Determine Final Format
      let targetFormat = null;
      if (formatData?.format) {
        const reqFormat = formatData.format.toLowerCase();
        if (ALLOWED_FORMATS.includes(reqFormat)) {
          targetFormat = reqFormat === "jpg" ? "jpeg" : reqFormat;
        }
      }

      const finalFormat = targetFormat || (originalFormat === "jpg" ? "jpeg" : originalFormat);

      // 6. Apply Format and Compression Settings
      const isCompressed = compressData?.compress === true;
      const standardQuality = isCompressed ? 75 : 95; 

      switch (finalFormat) {
        case "png":
          pipeline = pipeline.png({ compressionLevel: isCompressed ? 9 : 6 });
          break;
        case "webp":
          pipeline = pipeline.webp({ quality: standardQuality });
          break;
        case "avif":
          pipeline = pipeline.avif({ quality: standardQuality });
          break;
        case "jpeg":
        default:
          pipeline = pipeline.jpeg({ quality: standardQuality, mozjpeg: true });
          break;
      }

      // Execute sharp processing
      const outputBuffer = await pipeline.toBuffer();
      const contentType = `image/${finalFormat === 'jpg' ? 'jpeg' : finalFormat}`;

      // 7. Upload successfully transformed image to destination
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: destKey,
          Body: outputBuffer,
          ContentType: contentType,
        })
      );

      // 8. Delete original file on SUCCESS
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: sourceKey,
        })
      );

      console.log(`Success: Processed ${sourceKey} -> ${destKey} and deleted original.`);

    } catch (err) {
      console.error(`Error processing ${sourceKey}:`, err.message);

      // If we failed AFTER successfully fetching the object, move it to the errors folder
      if (inputBuffer && destKey) {
        try {
          // Format the error key (preventing double slashes like errors//myimage.png)
          const cleanDestKey = destKey.startsWith('/') ? destKey.substring(1) : destKey;
          const errorKey = `errors/${cleanDestKey}`;

          // Upload original broken file to the errors prefix
          await s3Client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: errorKey,
              Body: inputBuffer,
              ContentType: originalContentType,
            })
          );

          // Delete original file from /transformation prefix
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: sourceKey,
            })
          );

          console.log(`Handled Error: Moved failing file to ${errorKey} and deleted original.`);
        } catch (cleanupErr) {
          console.error(`CRITICAL: Failed to move error file or delete original for ${sourceKey}`, cleanupErr);
        }
      }
    }
  }
};

/**
 * Helper to safely parse JSON metadata strings
 */
function parseJsonMetadata(rawJson) {
  if (!rawJson) return null;
  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}
