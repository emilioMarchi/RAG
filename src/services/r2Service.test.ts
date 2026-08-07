import { describe, it, expect, vi, beforeEach } from 'vitest'

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

vi.mock('../config/env.js', () => ({
  env: { R2_BUCKET_NAME: 'b', CLOUDFLARE_ACCOUNT_ID: 'i', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_PUBLIC_DOMAIN: null }
}))

const { R2StorageService } = await import('./r2Service.js')

describe('R2StorageService', () => {
  let storage
  beforeEach(() => {
    vi.clearAllMocks()
    storage = new R2StorageService()
  })

  it('upload file returns key', async () => {
    mockSend.mockResolvedValue({})
    const r = await storage.uploadFile(Buffer.from('data'), 'f.txt', 'text/plain')
    expect(r.r2Key).toContain('documents/')
    expect(r.r2Key).toContain('f.txt')
    expect(r.publicUrl).toBeNull()
  })

  it('getDownloadUrl returns signed url', async () => {
    mockGetSignedUrl.mockResolvedValue('signed-url')
    const url = await storage.getDownloadUrl('key', 3600)
    expect(url).toBe('signed-url')
  })

  it('deleteFile calls delete', async () => {
    mockSend.mockResolvedValue({})
    await storage.deleteFile('key')
    expect(mockSend).toHaveBeenCalled()
  })
})