// The template library query and its screen view (M-A4 §6.4). The library is fetched
// only while the sender context does not already refuse templates.
import { useQuery } from '@tanstack/react-query';

import { useServices } from '../../app/ServicesContext';
import { useSenderContext } from '../inbox/queries';
import { loadTemplateLibrary } from '../send/templates';
import { contextRefusal, templatesView, type TemplatesView } from './templatesModel';

export const templateLibraryKey = ['sign', 'sender', 'templates', 'library'] as const;

export function useTemplatesView(enabled = true): {
  readonly view: TemplatesView;
  readonly refetch: () => void;
  readonly refreshing: boolean;
} {
  const { workspace } = useServices();
  const context = useSenderContext(enabled);
  const allowed = context.data !== undefined && contextRefusal(context.data) === null;
  const library = useQuery({
    queryKey: templateLibraryKey,
    queryFn: () => loadTemplateLibrary(workspace),
    // Without a context answer, the route itself gives the server's reason.
    enabled: enabled && (allowed || context.isError),
  });
  return {
    view: templatesView({
      context: context.data,
      contextLoading: context.isPending,
      library: library.data,
      libraryLoading: library.isPending && library.fetchStatus !== 'idle',
      error: library.error,
    }),
    refetch: () => {
      void context.refetch();
      void library.refetch();
    },
    refreshing: library.isRefetching || context.isRefetching,
  };
}
