import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StorageResult {
  key: string;
  publicUrl: string | null;
  isLocal: boolean;
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Servicio de almacenamiento con dos modos:
 *  - 'local' (default): guarda los archivos en disco (LOCAL_STORAGE_DIR), ideal para uso local
 *  - 'r2': sube a Cloudflare R2 (S3) si se configuraron credenciales
 */
export class StorageService {
  private s3Client: S3Client | null = null;
  private bucketName: string | null = null;

  constructor() {
    if (env.STORAGE_MODE === 'r2') {
      if (!env.CLOUDFLARE_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
        throw new Error(
          'STORAGE_MODE=r2 requiere CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET_NAME'
        );
      }
      this.bucketName = env.R2_BUCKET_NAME;
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      });
    } else {
      this.ensureLocalDir();
    }
  }

  private resolveLocalDir(): string {
    const dir = env.LOCAL_STORAGE_DIR;
    return path.isAbsolute(dir) ? dir : path.join(__dirname, '..', '..', dir);
  }

  private ensureLocalDir(): void {
    const dir = this.resolveLocalDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async uploadFile(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<StorageResult> {
    if (this.s3Client && this.bucketName) {
      const key = `documents/${Date.now()}-${safeFileName(fileName)}`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: fileBuffer,
          ContentType: mimeType,
        })
      );
      return {
        key,
        publicUrl: env.R2_PUBLIC_DOMAIN ? `${env.R2_PUBLIC_DOMAIN}/${key}` : null,
        isLocal: false,
      };
    }

    // Modo local
    const dir = this.resolveLocalDir();
    this.ensureLocalDir();
    const relName = `${Date.now()}-${safeFileName(fileName)}`;
    fs.writeFileSync(path.join(dir, relName), fileBuffer);
    return { key: relName, publicUrl: null, isLocal: true };
  }

  /** Lee el contenido binario de un archivo (modo local o R2) como Buffer. */
  async readFile(key: string): Promise<Buffer> {
    if (this.s3Client && this.bucketName) {
      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      const response = await this.s3Client.send(command);
      if (!response.Body) throw new Error('Empty object body');
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    const dir = this.resolveLocalDir();
    const fullPath = path.join(dir, safeFileName(key));
    return fs.readFileSync(fullPath);
  }

  async getDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    if (this.s3Client && this.bucketName) {
      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    }
    const dir = this.resolveLocalDir();
    return path.join(dir, safeFileName(key));
  }

  async deleteFile(key: string): Promise<void> {
    if (this.s3Client && this.bucketName) {
      await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
      return;
    }
    const dir = this.resolveLocalDir();
    const fullPath = path.join(dir, safeFileName(key));
    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch {
      // Ignorar si el archivo no existe
    }
  }
}
