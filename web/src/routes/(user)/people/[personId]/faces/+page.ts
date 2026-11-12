import { getPerson } from '@immich/sdk';
import { authenticate } from '#lib/utils/auth';
import { getFormatter } from '#lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);
  const person = await getPerson({ id: params.personId });
  const $t = await getFormatter();

  return {
    person,
    meta: {
      title: `${$t('sort_faces')} · ${person.name || $t('person')}`,
    },
  };
}) satisfies PageLoad;
