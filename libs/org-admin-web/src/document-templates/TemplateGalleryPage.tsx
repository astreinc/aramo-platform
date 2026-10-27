import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { safeErrorMessage, type Session } from '@aramo/fe-foundation';
import { fetchTemplateLibrary, useDocTemplateRoutes, type TemplateLibraryView } from '@aramo/document-templates-web';

import { ORG_SECTION_INTRO } from '../sections';
import { OrgPageHeader } from '../ui/OrgPage';

import { GALLERY_CATEGORIES, buildGalleryCards, categoryCounts, type GalleryCategory } from './templates-view';
import './templates.css';

// ORG-UX-1 — Template gallery (Directive v1.0 LOCKED §3, §5.1, §5.5; handoff rev. Oct 21
// §6.9, revised: horizontal cards, category chips, 2-column grid). Ready-made starting points.
//
// TEMPLATE-STUDIO-1 S-2 (directive §4; conforming amendments #2, #3) — BACKEND-DRIVEN: one
// card per published Aramo default from GET /v1/document-templates/library (PLATFORM items;
// the server lists current versions only and leaves out withdrawn defaults). No static
// "Not configurable yet" cards. Category chips and counts come from the actual cards; empty
// categories are hidden. A card opens the Aramo default in the shared Template Studio
// (/org/document-templates/aramo/:id), read only, in Preview — Adopt is the Studio's header
// action (AramoDefaultStudio). A type the organization already has shows "In Our templates".

/** Directive §5.5 — the responsibility sentence (gallery header + Adopt confirmation). */
export const RESPONSIBILITY_SENTENCE = 'Your organization is responsible for the content of any template it approves.';

type Filter = 'All' | GalleryCategory;

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; library: TemplateLibraryView };

interface Props {
  readonly session: Session;
  readonly libraryFn?: typeof fetchTemplateLibrary;
}

export function TemplateGalleryPage({ libraryFn = fetchTemplateLibrary }: Props) {
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  // Client-side, never persisted: a reload starts at All (§6.9).
  const [filter, setFilter] = useState<Filter>('All');
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

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

  const cards = useMemo(() => (load.status === 'ready' ? buildGalleryCards(load.library) : []), [load]);
  const counts = categoryCounts(cards);
  const chips = GALLERY_CATEGORIES.filter((c) => counts[c] > 0);
  const active: Filter = filter !== 'All' && counts[filter] === 0 ? 'All' : filter;
  const shown = cards.filter((c) => active === 'All' || c.category === active);
  const introHasSentence = ORG_SECTION_INTRO.gallery.includes(RESPONSIBILITY_SENTENCE);
  const open = (id: string) => navigate(`${routes.list}/aramo/${encodeURIComponent(id)}`);

  return (
    <div className="ox-tpl" data-testid="template-gallery">
      <OrgPageHeader section="gallery" />
      {introHasSentence ? null : <p className="ox-tpl__intro-extra">{RESPONSIBILITY_SENTENCE}</p>}

      {cards.length > 0 ? (
        <div role="toolbar" aria-label="Filter by category" className="ox-gal__chips">
          {(['All', ...chips] as const).map((c) => (
            <button key={c} type="button" className="ox-gal__chip" aria-pressed={active === c} onClick={() => setFilter(c)} data-testid={`gallery-chip-${c}`}>
              {c}
              <span className="ox-gal__chipcount">{counts[c]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {load.status === 'error' ? (
        <div className="ox-alert ox-alert--error ox-tpl__banner" role="alert">
          {load.message}{' '}
          <button type="button" className="ox-link" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : null}

      {load.status === 'ready' && cards.length === 0 ? (
        <p className="ox-gal__empty" data-testid="gallery-empty">
          No Aramo templates are published yet.
        </p>
      ) : null}

      <div className="ox-gal__grid" aria-busy={load.status === 'loading'}>
        {shown.map((card) => (
          // The whole card opens the Studio (pointer); Preview is the keyboard / AT path.
          <article
            key={card.id}
            aria-label={card.name}
            className="ox-gal__card ox-gal__card--open"
            data-testid={`gallery-card-${card.id}`}
            onClick={() => open(card.id)}
          >
            <div className="ox-gal__well" aria-hidden="true">
              <div className="ox-gal__page">
                <span className="ox-gal__logo">
                  <span className="ox-gal__logosq" />
                  <span className="ox-gal__line ox-gal__line--flex" />
                </span>
                <span className="ox-gal__pagename">{card.name}</span>
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
              <h3 className="ox-gal__name">{card.name}</h3>
              <p className="ox-gal__desc">{card.description}</p>
              <div className="ox-gal__foot">
                <span className="ox-gal__cat">{card.category}</span>
                <span className="ox-gal__spacer" />
                {card.state.kind === 'in-ours' ? (
                  <Link
                    to={routes.detail(card.state.ourTemplateId)}
                    className="ox-gal__inours"
                    onClick={(e) => e.stopPropagation()}
                    data-testid="gallery-in-ours"
                  >
                    In Our templates
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="ox-btn ox-btn--secondary ox-btn--sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    open(card.id);
                  }}
                  aria-label={`Preview ${card.name}`}
                  data-testid="gallery-preview"
                >
                  Preview
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
