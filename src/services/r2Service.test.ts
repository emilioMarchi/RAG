import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockSend = vi.fn()
const mockGetSignedUrl = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    constructor() {
      this.send = mockSend
    }
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn()
  }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl
}))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'))

vi.mock('../config/env.js', () => ({
  env: {
    STORAGE_MODE: 'local',
    LOCAL_STORAGE_DIR: tmpDir,
    R2_BUCKET_NAME: 'b',
    CLOUDFLARE_ACCOUNT_ID: 'i',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_PUBLIC_DOMAIN: null
  }
}))

const { StorageService } = await import('./r2Service.js')

describe('StorageService (modo local)', () => {
  let storage: StorageService
  beforeEach(() => {
    vi.clearAllMocks()
    storage = new StorageService()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upload file escribe en disco y devuelve key local', async () => {
    const r = await storage.uploadFile(Buffer.from('data'), 'f.txt', 'text/plain')
    expect(r.isLocal).toBe(true)
    expect(r.publicUrl).toBeNull()
    expect(fs.existsSync(path.join(tmpDir, r.key))).toBe(true)
  })

  it('getDownloadUrl devuelve la ruta local', async () => {
    const r = await storage.uploadFile(Buffer.from('data'), 'f.txt', 'text/plain')
    const url = await storage.getDownloadUrl(r.key)
    expect(url).toContain(r.key)
  })

  it('deleteFile elimina el archivo local', async () => {
    const r = await storage.uploadFile(Buffer.from('data'), 'f.txt', 'text/plain')
    const fullPath = path.join(tmpDir, r.key)
    expect(fs.existsSync(fullPath)).toBe(true)
    await storage.deleteFile(r.key)
    expect(fs.existsSync(fullPath)).toBe(false)
  })

  it('uploadFile usa nombre de archivo sanitizado', async () => {
    const r = await storage.uploadFile(Buffer.from('x'), 'a/b:c.txt', 'text/plain')
    expect(r.key).toContain('_')
    expect(r.key).not.toContain('/')
  })
})
