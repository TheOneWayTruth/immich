import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  return {
    personId: url.searchParams.get('personId') ?? undefined,
    meta: {
      title: $t('family_tree'),
    },
  };
}) satisfies PageLoad;
