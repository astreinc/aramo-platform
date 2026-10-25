import { ApiError, clientError } from '../../../api/errors';
import { UPLOAD_ATTEMPTS, uploadWithRetry } from '../syncDraft';

const DOC = { id: 'doc-1', title: 'Offer', pages: [{ width: 612, height: 792 }] };
const noSleep = async () => undefined;

describe('upload retry (M-A3 §8)', () => {
  it('retries network failures, a 5xx and an in-progress replay, then succeeds', async () => {
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(clientError('network_unavailable'))
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          reason: 'idempotency_request_in_progress',
        }),
      )
      .mockResolvedValueOnce(DOC);
    await expect(uploadWithRetry(attempt, noSleep, 3)).resolves.toBe(DOC);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('never retries a refusal (4xx), e.g. a Word file or a stale version', async () => {
    for (const reason of ['unsupported_file_type', 'revision_mismatch', 'idempotency_key_reuse']) {
      const attempt = jest
        .fn()
        .mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_ERROR', reason }));
      await expect(uploadWithRetry(attempt, noSleep)).rejects.toMatchObject({ reason });
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after the last attempt', async () => {
    const attempt = jest.fn().mockRejectedValue(clientError('network_unavailable'));
    await expect(uploadWithRetry(attempt, noSleep)).rejects.toMatchObject({
      reason: 'network_unavailable',
    });
    expect(attempt).toHaveBeenCalledTimes(UPLOAD_ATTEMPTS);
  });
});
