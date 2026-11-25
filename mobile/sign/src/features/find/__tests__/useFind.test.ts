// Android field test 2026-11-25 — Find in the Send editor said "No searchable text in this
// document" for a PDF not uploaded yet. It now says the document is not uploaded yet, and loads
// the text as soon as the document reaches the server while Find is open.
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { TextLayer } from '../../../api/m-a12-contract-types';
import { FIND_COPY } from '../findModel';
import { useFind, type FindDoc } from '../useFind';

const w = (t: string, x: number) => ({ t, x, y: 0.1, w: 0.05, h: 0.01 });
const LAYER: TextLayer = { document_id: 'd1', pages: [{ page: 1, words: [w('Business', 0.1), w('user', 0.2)] }] };

describe('useFind', () => {
  it('a document not uploaded yet says so (not "No searchable text"), then loads once it is', async () => {
    const load = jest.fn(async () => LAYER);
    const { result, rerender } = renderHook(({ docs }: { docs: readonly FindDoc[] }) => useFind(docs), {
      initialProps: { docs: [{ docKey: 'a', load: null, pending: true }] as readonly FindDoc[] },
    });
    act(() => result.current.show());
    expect(result.current.status).toBe(FIND_COPY.notUploaded);
    // The draft finishes uploading while Find is open: the text loads without reopening Find.
    rerender({ docs: [{ docKey: 'a', load, pending: false }] });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => result.current.setQuery('user'));
    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    expect(result.current.status).toBe('1 of 1');
  });

  it('a document with no text layer at all still says "No searchable text"', async () => {
    const { result } = renderHook(() => useFind([{ docKey: 'a', load: async () => ({ document_id: 'd', pages: [{ page: 1, words: [] }] }) }]));
    act(() => result.current.show());
    await waitFor(() => expect(result.current.status).toBe(FIND_COPY.noText));
  });
});
