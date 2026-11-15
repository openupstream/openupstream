import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
    title: 'openupstream',
    description: 'Projects, Databases, Buckets and Services on openupstream',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
