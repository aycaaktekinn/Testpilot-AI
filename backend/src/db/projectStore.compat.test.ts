import { describe, expect, it } from 'vitest';
import { chooseProjectTable, chooseMembershipTable } from './projectStore.js';

describe('project schema compatibility', () => {
  it('prefers the table with actual project rows when both legacy and WEB_ tables exist', () => {
    const result = chooseProjectTable({
      hasWebProjects: true,
      hasLegacyProjects: true,
      webProjectRowCount: 0,
      legacyProjectRowCount: 5,
    });

    expect(result).toBe('PROJECTS');
  });

  it('prefers the table with actual membership rows when both legacy and WEB_ membership tables exist', () => {
    const result = chooseMembershipTable({
      hasWebMembers: true,
      hasLegacyMembers: true,
      webMemberRowCount: 0,
      legacyMemberRowCount: 3,
    });

    expect(result).toBe('PROJECT_MEMBERS');
  });
});
