'use client';

import { NodesPage } from '../../components/nodes';
import { Shell } from '../../components/shell';

/** `/nodes`: the installation's nodes and their Site labels, for madAuth's admins (ADR-0008). */
export default function Nodes() {
    return <Shell>{(user) => <NodesPage key={user.id} />}</Shell>;
}
