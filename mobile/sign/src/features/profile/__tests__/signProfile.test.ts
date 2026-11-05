// M-A12 W1-E — the Sign profile (validation, the PUT body, the auto-fill values) and the
// per-user settings (date format, default field size).
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import {
  asSettings,
  DEFAULT_SETTINGS,
  draftFromProfile,
  formatDate,
  loadProfile,
  loadSettings,
  profileBody,
  profileValue,
  saveSettings,
  validateProfile,
} from '../signProfile';

describe('profile', () => {
  it('requires a display name; checks length, phone (E.164) and country (ISO-2)', () => {
    const d = draftFromProfile(null);
    expect(validateProfile(d).display_name).toBe('Enter your name.');
    expect(validateProfile({ ...d, display_name: 'x'.repeat(121) }).display_name).toMatch(/120/);
    const bad = { ...d, display_name: 'Priya', phone: '555-1234', country: 'USA', city: 'x'.repeat(201) };
    expect(Object.keys(validateProfile(bad)).sort()).toEqual(['city', 'country', 'phone']);
    expect(validateProfile({ ...d, display_name: 'Priya', phone: '+15551234567', country: 'us' })).toEqual({});
  });

  it('sends trimmed values; an emptied optional field is cleared (null); country upper-case', () => {
    const body = profileBody({ ...draftFromProfile(null), display_name: ' Priya ', company: ' ', country: 'in' });
    expect(body).toMatchObject({ display_name: 'Priya', company: null, country: 'IN', title: null });
  });

  it('auto-fill values for the profile field types', () => {
    const p = { display_name: 'Priya Devi Raman', company: 'Northwind', title: 'Recruiter' };
    expect(profileValue('FIRST_NAME', p, 'p@example.com')).toBe('Priya');
    expect(profileValue('LAST_NAME', p, null)).toBe('Devi Raman');
    expect(profileValue('EMAIL', p, 'p@example.com')).toBe('p@example.com');
    expect(profileValue('COMPANY', p, null)).toBe('Northwind');
    expect(profileValue('TITLE', p, null)).toBe('Recruiter');
    expect(profileValue('TEXT', p, null)).toBeNull();
    expect(profileValue('COMPANY', null, null)).toBeNull();
  });

  it('GET /v1/sign/me/profile; 404 = no profile yet', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 404, body: { reason: 'not_found', code: 'not_found' } }));
    expect(await loadProfile(workspace)).toBeNull();
    expect(net.calls[0]?.url).toMatch(/\/v1\/sign\/me\/profile$/);
  });
});

describe('settings', () => {
  it('formats dates in the three formats', () => {
    const d = new Date(2026, 10, 5);
    expect(formatDate(d, 'MM/DD/YYYY')).toBe('11/05/2026');
    expect(formatDate(d, 'DD/MM/YYYY')).toBe('05/11/2026');
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-11-05');
  });

  it('defaults MM/DD/YYYY and M; unknown values fall back', () => {
    expect(DEFAULT_SETTINGS).toEqual({ date_format: 'MM/DD/YYYY', default_field_size: 'M' });
    expect(asSettings({ date_format: 'D.M.Y', default_field_size: 'XL' })).toEqual(DEFAULT_SETTINGS);
  });

  it('GET and PUT /v1/sign/me/settings', async () => {
    const { net, workspace } = workspaceWith((req) =>
      req.method === 'PUT' ? { status: 200, body: req.body } : { status: 200, body: { date_format: 'YYYY-MM-DD', default_field_size: 'L' } },
    );
    expect(await loadSettings(workspace)).toEqual({ date_format: 'YYYY-MM-DD', default_field_size: 'L' });
    await saveSettings(workspace, { date_format: 'DD/MM/YYYY', default_field_size: 'S' });
    expect(net.calls[1]).toMatchObject({ method: 'PUT', body: { date_format: 'DD/MM/YYYY', default_field_size: 'S' } });
  });
});
