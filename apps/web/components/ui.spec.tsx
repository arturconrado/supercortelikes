import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { EmptyState, Progress, StatusBadge } from './ui';

describe('shared UI states', () => {
  it('translates pipeline states for people', () => {
    render(<StatusBadge status="PROCESSING" />);
    expect(screen.getByText('Processando')).toBeInTheDocument();
  });

  it('exposes an intentional empty state', () => {
    render(<EmptyState title="Nada por aqui" description="Envie um vídeo para começar." />);
    expect(screen.getByRole('heading', { name: 'Nada por aqui' })).toBeInTheDocument();
  });

  it('clamps progress to its valid visual range', () => {
    const { container } = render(<Progress value={140} />);
    expect(container.querySelector('[style]')).toHaveStyle({ width: '100%' });
  });
});
