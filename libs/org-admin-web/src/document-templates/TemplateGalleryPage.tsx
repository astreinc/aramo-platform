import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { safeErrorMessage, useToast, type Session } from '@aramo/fe-foundation';
import {
  adoptTemplate,
  canAuthorTemplates,
  fetchTemplateLibrary,
  useDocTemplateRoutes,
  type TemplateLibraryView,
} from '@aramo/document-templates-web';

import { ORG_SECTION_INTRO } from '../sections';
import { OrgModal, OrgPageHeader } from '../ui/OrgPage';

import {
  GALLERY_CATEGORIES,
  GALLERY_ENTRIES,
  categoryCounts,
  galleryAvailability,
  type GalleryAvailability,
  type GalleryCategory,
  type GalleryEntry,
} from './templates-view';
import './templates.css';

// ORG-UX-1 — Template gallery (Directive v1.0 LOCKED §3, §5.1, §5.5, §8.8; handoff rev.
// Oct 21 §6.9, revised: horizontal cards, category chips, 2-column grid). Ready-made
// starting points. Only template-driven types (RTR today) can be previewed or adopted:
// Adopt (document_template:author; POST /v1/document-templates/adopt) creates an
// independent DRAFT in Our templates — nothing is used until an owner or administrator
// approves it. The other cards are static "Not configurable yet" entries (G13: the
// category and description copy comes from the handoff, not a backend catalog).

/** Directive §5.5 — the responsibility sentence (gallery header + Adopt confirmation). */
export const RESPONSIBILITY_SENTENCE = 'Your organization is responsible for the content of any template it approves.';

type Filter = 'All' | GalleryCategory;

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; library: TemplateLibraryView };

interface Props {
  readonly session: Session;
  readonly libraryFn?: typeof fetchTemplateLibrary;
  readonly adoptFn?: typeof adoptTemplate;
}

export function TemplateGalleryPage({ session, libraryFn = fetchTemplateLibrary, adoptFn = adoptTemplate }: Props) {
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  const toast = useToast();
  const canAuthor = canAuthorTemplates(session);
  // Client-side, never persisted: a reload starts at All (§6.9).
  const [filter, setFilter] = useState<Filter>('All');
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [adopting, setAdopting] = useState<{ entry: GalleryEntry; libraryId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adoptError, setAdoptError] = useState('');

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', library: await libraryFn() });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Could not load the template gallery.') });
    }
  }, [libraryFn]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const counts = categoryCounts(GALLERY_ENTRIES);
  const shown = GALLERY_ENTRIES.filter((e) => filter === 'All' || e.category === filter);
  const library = load.status === 'ready' ? load.library : null;
  const introHasSentence = ORG_SECTION_INTRO.gallery.includes(RESPONSIBILITY_SENTENCE);

  async function confirmAdopt() {
    if (adopting === null) return;
    setBusy(true);
    setAdoptError('');
    try {
      const { template } = await adoptFn(adopting.libraryId);
      setAdopting(null);
      toast.show(`${adopting.entry.name} added to Our templates as a draft. Nothing is used until it’s approved.`);
      navigate(routes.draft(template.id));
    } catch (err) {
      setAdoptError(safeErrorMessage(err, 'Could not adopt this template.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ox-tpl" data-testid="template-gallery">
      <OrgPageHeader section="gallery" />
      {introHasSentence ? null : <p className="ox-tpl__intro-extra">{RESPONSIBILITY_SENTENCE}</p>}

      <div role="toolbar" aria-label="Filter by category" className="ox-gal__chips">
        {(['All', ...GALLERY_CATEGORIES] as const).map((c) => (
          <button key={c} type="button" className="ox-gal__chip" aria-pressed={filter === c} onClick={() => setFilter(c)} data-testid={`gallery-chip-${c}`}>
            {c}
            <span className="ox-gal__chipcount">{counts[c]}</span>
          </button>
        ))}
      </div>

      {load.status === 'error' ? (
        <div className="ox-alert ox-alert--error ox-tpl__banner" role="alert">
          {load.message}{' '}
          <button type="button" className="ox-link" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : null}

      <div className="ox-gal__grid" aria-busy={load.status === 'loading'}>
        {shown.map((entry) => {
          const avail: GalleryAvailability = galleryAvailability(entry, library);
          const supported = avail.kind !== 'unsupported';
          // While the library loads, a template-driven card shows no action yet (never a
          // misleading "Not configurable yet").
          const pending = library === null && entry.typeKey !== null;
          return (
            <article key={entry.name} aria-label={entry.name} className="ox-gal__card" data-testid={`gallery-card-${entry.name}`}>
              <div className="ox-gal__well" aria-hidden="true">
                <div className={`ox-gal__page${supported ? '' : ' ox-gal__page--off'}`}>
                  <span className="ox-gal__logo">
                    <span className="ox-gal__logosq" />
                    <span className="ox-gal__line ox-gal__line--flex" />
                  </span>
                  <span className="ox-gal__pagename">{entry.name}</span>
                  <span className="ox-gal__line ox-gal__line--gap" />
                  <span className="ox-gal__line" />
                  <span className="ox-gal__line" style={{ width: '82%' }} />
                  <span className="ox-gal__line ox-gal__line--field" style={{ width: '46%' }} />
                  <span className="ox-gal__line ox-gal__line--gap2" />
                  <span className="ox-gal__line" style={{ width: '70%' }} />
                  <span className="ox-gal__line" />
                  <span className="ox-gal__line ox-gal__line--field" style={{ width: '38%' }} />
                </div>
              </div>
              <div className="ox-gal__text">
                <h3 className="ox-gal__name">{entry.name}</h3>
                <p className="ox-gal__desc">{entry.description}</p>
                <div className="ox-gal__foot">
                  <span className="ox-gal__cat">{entry.category}</span>
                  <span className="ox-gal__spacer" />
                  {pending ? null : avail.kind === 'unsupported' ? (
                    <span className="ox-pill ox-pill--disabled" data-testid="gallery-not-configurable">
                      Not configurable yet
                    </span>
                  ) : (
                    <>
                      {avail.kind === 'in-ours' ? (
                        <span className="ox-gal__inours" data-testid="gallery-in-ours">
                          In Our templates
                        </span>
                      ) : null}
                      {avail.libraryId !== null ? (
                        <button
                          type="button"
                          className="ox-btn ox-btn--secondary ox-btn--sm"
                          onClick={() => navigate(`${routes.list}/aramo/${encodeURIComponent(avail.libraryId as string)}`)}
                          aria-label={`Preview ${entry.name}`}
                          data-testid="gallery-preview"
                        >
                          Preview
                        </button>
                      ) : null}
                      {avail.kind === 'adoptable' && canAuthor ? (
                        <button
                          type="button"
                          className="ox-btn ox-btn--primary ox-btn--sm"
                          onClick={() => {
                            setAdoptError('');
                            setAdopting({ entry, libraryId: avail.libraryId });
                          }}
                          aria-label={`Adopt ${entry.name}`}
                          data-testid="gallery-adopt"
                        >
                          Adopt
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <OrgModal
        open={adopting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAdopting(null);
        }}
        title={adopting !== null ? `Adopt ${adopting.entry.name}?` : 'Adopt'}
        subtitle="This creates a draft in Our templates. Nothing is used until it’s approved."
        testId="gallery-adopt-modal"
        footer={
          <>
            <button type="button" className="ox-btn ox-btn--secondary" onClick={() => setAdopting(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="ox-btn ox-btn--primary" onClick={() => void confirmAdopt()} disabled={busy} data-testid="gallery-adopt-confirm">
              Adopt
            </button>
          </>
        }
      >
        <p className="ox-tpl__modaltext">{RESPONSIBILITY_SENTENCE}</p>
        {adoptError !== '' ? (
          <p className="ox-error" role="alert">
            {adoptError}
          </p>
        ) : null}
      </OrgModal>
    </div>
  );
}
