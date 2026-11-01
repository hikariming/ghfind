'use client';

import { useState } from 'react';
import Image from 'next/image';
import { GitFork } from 'lucide-react';
import type { Talent } from './data';
import styles from './talent.module.css';

export function TalentAvatar({ talent, badge = false }: { talent: Talent; badge?: boolean }) {
  const handle = talent.handle.trim().replace(/^@/, '');
  const [failedHandle, setFailedHandle] = useState<string | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const hasGitHub = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(handle);
  const customAvatar = talent.avatarUrl && failedAvatar !== talent.avatarUrl ? talent.avatarUrl : null;
  return <span className={`${styles.avatar} ${styles[talent.color]}`}>
    {customAvatar ? <Image
      className={styles.avatarImage}
      src={customAvatar}
      alt={`${talent.name} 的头像`}
      width={80}
      height={80}
      unoptimized
      onError={() => setFailedAvatar(customAvatar)}
    /> : hasGitHub && failedHandle !== handle ? <Image
      className={styles.avatarImage}
      src={`https://github.com/${encodeURIComponent(handle)}.png?size=160`}
      alt={`${talent.name} 的 GitHub 头像`}
      width={80}
      height={80}
      unoptimized
      onError={() => setFailedHandle(handle)}
    /> : talent.initials}
    {badge && hasGitHub && <span className={styles.avatarMark}><GitFork size={11} /></span>}
  </span>;
}
