import NextLink from 'next/link';
import type { ComponentProps } from 'react';

type SafeLinkProps = ComponentProps<typeof NextLink>;

export default function SafeLink(props: SafeLinkProps) {
  return <NextLink {...props} prefetch={props.prefetch ?? false} />;
}
