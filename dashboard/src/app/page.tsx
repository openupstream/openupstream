'use client';

import { Projects } from '../components/projects';
import { Shell } from '../components/shell';

export default function Home() {
    return <Shell>{(user) => <Projects key={user.id} />}</Shell>;
}
