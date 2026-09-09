'use client';

import { RouteError } from '@/components/errors/RouteError';

export default function SegmentError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}
