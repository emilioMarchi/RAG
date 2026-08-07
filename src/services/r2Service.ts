import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

export class R2StorageService {
  private s3Client: S3Client;
  private bucketName: string;

  constructor() {
    this.bucketName = env.R2_BUCKET_NAME;
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  async uploadFile(fileBuffer: Buffer, fileName: string, mimeType: string) {
    const key = `documents/${Date.now()}-${fileName}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
      })
    );

    return {
      r2Key: key,
      publicUrl: env.R2_PUBLIC_DOMAIN
        ? `${env.R2_PUBLIC_DOMAIN}/${key}`
        : null,
    };
  }

  async getDownloadUrl(r2Key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: r2Key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }

  async deleteFile(r2Key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      })
    );
  }
}
