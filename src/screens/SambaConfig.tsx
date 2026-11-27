import path from 'node:path';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { InputField } from '../components/InputField.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { AdIdentityValidator, filterAdSuggestions } from '../modules/adValidation.js';
import { validateShareAclConsistency } from '../modules/permissions.js';
import { SambaManager } from '../modules/samba.js';
import type {
  ActiveDirectoryPersistedConfig,
  ResolvedAdIdentity,
  SambaApplyResult,
  SambaShareConfig,
  ShareAccessMode,
} from '../types/index.js';
import { validateInput } from '../validation/retry.js';
import { sambaDescriptionSchema, sambaShareNameSchema, shareSubfolderSchema } from '../validation/schemas.js';

const DEFAULT_AD_VALIDATOR = new AdIdentityValidator();
const DEFAULT_SAMBA_MANAGER = new SambaManager();

export interface SambaConfigProps {
  configuredMountPoints: string[];
  existingShares: SambaShareConfig[];
  preferredMountPoint?: string;
  adConfig?: ActiveDirectoryPersistedConfig;
  adValidator?: AdIdentityValidator;
  sambaManager?: SambaManager;
  onComplete: (shares: SambaShareConfig[], applyResult: SambaApplyResult) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase =
  | 'share_list'
  | 'wizard_mount'
  | 'wizard_details'
  | 'wizard_identities'
  | 'confirm_apply'
  | 'applying'
  | 'error';

type IdentityBucket = 'rw_group' | 'ro_group' | 'rw_user' | 'ro_user';
type IdentityFocusMode = 'input' | 'remove_list';

interface AddedIdentityItem {
  bucket: IdentityBucket;
  tag: string;
  identity: ResolvedAdIdentity;
}

export const SambaConfig: React.FC<SambaConfigProps> = ({
  configuredMountPoints,
  existingShares,
  preferredMountPoint,
  adConfig,
  adValidator = DEFAULT_AD_VALIDATOR,
  sambaManager = DEFAULT_SAMBA_MANAGER,
  onComplete,
  onBack,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const initialMountIdx = Math.max(
    0,
    preferredMountPoint ? configuredMountPoints.indexOf(preferredMountPoint) : 0,
  );
  const startInWizard =
    existingShares.length === 0 ||
    Boolean(preferredMountPoint && !existingShares.some((s) => s.baseMountPoint === preferredMountPoint));

  const [shares, setShares] = useState<SambaShareConfig[]>(existingShares);
  const [phase, setPhase] = useState<Phase>(startInWizard ? 'wizard_mount' : 'share_list');
  const [listCursor, setListCursor] = useState(0);

  const [mountIdx, setMountIdx] = useState(initialMountIdx);
  const [detailFocus, setDetailFocus] = useState(0);
  const [shareName, setShareName] = useState('');
  const [description, setDescription] = useState('');
  const [subfolder, setSubfolder] = useState('');
  const [accessMode, setAccessMode] = useState<ShareAccessMode>('read_write');
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [detailErrorSummary, setDetailErrorSummary] = useState<string | undefined>();

  // AD Identity & Autocomplete & Removal state
  const [bucket, setBucket] = useState<IdentityBucket>('rw_group');
  const [identityFocusMode, setIdentityFocusMode] = useState<IdentityFocusMode>('input');
  const [identityInput, setIdentityInput] = useState('');
  const [identityError, setIdentityError] = useState<string | undefined>();
  const [validatingId, setValidatingId] = useState(false);
  const [rwGroups, setRwGroups] = useState<ResolvedAdIdentity[]>([]);
  const [roGroups, setRoGroups] = useState<ResolvedAdIdentity[]>([]);
  const [rwUsers, setRwUsers] = useState<ResolvedAdIdentity[]>([]);
  const [roUsers, setRoUsers] = useState<ResolvedAdIdentity[]>([]);
  const [availableGroups, setAvailableGroups] = useState<string[]>([]);
  const [availableUsers, setAvailableUsers] = useState<string[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(-1);
  const [removeCursor, setRemoveCursor] = useState(0);

  const [applyResult, setApplyResult] = useState<SambaApplyResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [recoverySteps, setRecoverySteps] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      adValidator.listAvailableIdentities('group'),
      adValidator.listAvailableIdentities('user'),
    ])
      .then(([groups, users]) => {
        if (!active) return;
        setAvailableGroups(groups);
        setAvailableUsers(users);
      })
      .catch(() => {
        // Manual entry + wbinfo validation remain available
      });
    return () => {
      active = false;
    };
  }, [adValidator]);

  const resetWizardDraft = (): void => {
    setMountIdx(initialMountIdx);
    setDetailFocus(0);
    setShareName('');
    setDescription('');
    setSubfolder('');
    setAccessMode('read_write');
    setDetailErrors({});
    setDetailErrorSummary(undefined);
    setBucket('rw_group');
    setIdentityFocusMode('input');
    setIdentityInput('');
    setIdentityError(undefined);
    setSuggestionIdx(-1);
    setRemoveCursor(0);
    setRwGroups([]);
    setRoGroups([]);
    setRwUsers([]);
    setRoUsers([]);
  };

  const selectedBaseMount = configuredMountPoints[mountIdx] ?? configuredMountPoints[0] ?? '';

  const addedItems: AddedIdentityItem[] = useMemo(
    () => [
      ...rwGroups.map((identity) => ({ bucket: 'rw_group' as const, tag: 'RW Group', identity })),
      ...roGroups.map((identity) => ({ bucket: 'ro_group' as const, tag: 'RO Group', identity })),
      ...rwUsers.map((identity) => ({ bucket: 'rw_user' as const, tag: 'RW User', identity })),
      ...roUsers.map((identity) => ({ bucket: 'ro_user' as const, tag: 'RO User', identity })),
    ],
    [rwGroups, roGroups, rwUsers, roUsers],
  );

  const isGroupBucket = bucket === 'rw_group' || bucket === 'ro_group';
  const suggestions = useMemo(() => {
    const pool = isGroupBucket ? availableGroups : availableUsers;
    const alreadyAdded = isGroupBucket
      ? [...rwGroups, ...roGroups].flatMap((g) => [g.normalized, g.input])
      : [...rwUsers, ...roUsers].flatMap((u) => [u.normalized, u.input]);
    return filterAdSuggestions(pool, identityInput, alreadyAdded, 6);
  }, [isGroupBucket, availableGroups, availableUsers, rwGroups, roGroups, rwUsers, roUsers, identityInput]);

  useEffect(() => {
    if (suggestionIdx >= suggestions.length) {
      setSuggestionIdx(suggestions.length > 0 ? suggestions.length - 1 : -1);
    }
  }, [suggestions.length, suggestionIdx]);

  useEffect(() => {
    if (addedItems.length === 0 && identityFocusMode === 'remove_list') {
      setIdentityFocusMode('input');
      setRemoveCursor(0);
    } else if (removeCursor >= addedItems.length && addedItems.length > 0) {
      setRemoveCursor(addedItems.length - 1);
    }
  }, [addedItems.length, identityFocusMode, removeCursor]);

  const removeIdentityItem = (targetBucket: IdentityBucket, numericId: number): void => {
    if (targetBucket === 'rw_group') setRwGroups((prev) => prev.filter((g) => g.numericId !== numericId));
    else if (targetBucket === 'ro_group') setRoGroups((prev) => prev.filter((g) => g.numericId !== numericId));
    else if (targetBucket === 'rw_user') setRwUsers((prev) => prev.filter((u) => u.numericId !== numericId));
    else setRoUsers((prev) => prev.filter((u) => u.numericId !== numericId));
    setIdentityError(undefined);
  };

  const undoLastInActiveBucket = (): void => {
    if (bucket === 'rw_group' && rwGroups.length > 0) setRwGroups((prev) => prev.slice(0, -1));
    else if (bucket === 'ro_group' && roGroups.length > 0) setRoGroups((prev) => prev.slice(0, -1));
    else if (bucket === 'rw_user' && rwUsers.length > 0) setRwUsers((prev) => prev.slice(0, -1));
    else if (bucket === 'ro_user' && roUsers.length > 0) setRoUsers((prev) => prev.slice(0, -1));
    setIdentityError(undefined);
  };

  const validateShareDetailsAndAdvance = (): void => {
    const errors: Record<string, string> = {};
    const nameVal = validateInput(sambaShareNameSchema, shareName);
    if (!nameVal.success) errors['name'] = nameVal.errorSummary ?? 'Invalid share name.';
    else if (shares.some((s) => s.name.toLowerCase() === nameVal.data!.toLowerCase())) {
      errors['name'] = `Share name "${nameVal.data}" already exists. Choose a unique share name.`;
    }

    const descVal = validateInput(sambaDescriptionSchema, description);
    if (!descVal.success) errors['description'] = descVal.errorSummary ?? 'Invalid description.';

    const subVal = validateInput(shareSubfolderSchema, subfolder);
    if (!subVal.success) errors['subfolder'] = subVal.errorSummary ?? 'Invalid subfolder.';

    if (Object.keys(errors).length > 0) {
      setDetailErrors(errors);
      setDetailErrorSummary(errors['name'] ?? errors['description'] ?? errors['subfolder']);
      return;
    }

    setShareName(nameVal.data!);
    setDescription(descVal.data!);
    setSubfolder(subVal.data!);
    setDetailErrors({});
    setDetailErrorSummary(undefined);
    setBucket(accessMode === 'read_write' ? 'rw_group' : 'ro_group');
    setIdentityFocusMode('input');
    setSuggestionIdx(-1);
    setPhase('wizard_identities');
  };

  const handleAddIdentity = async (rawValue: string): Promise<void> => {
    const chosen = suggestionIdx >= 0 && suggestions[suggestionIdx] ? suggestions[suggestionIdx]! : rawValue;
    const trimmed = chosen.trim();
    if (!trimmed) {
      setIdentityError('Enter an AD group or username, pick a suggestion with ↓, or press Ctrl+D / Ctrl+S to save share.');
      return;
    }
    setValidatingId(true);
    setIdentityError(undefined);

    const expectedKind = bucket === 'rw_group' || bucket === 'ro_group' ? 'group' : 'user';
    const res = await adValidator.validateIdentity(trimmed, expectedKind, adConfig?.netbiosName);
    setValidatingId(false);

    if (!res.valid || !res.identity) {
      setIdentityError(res.error ?? `Unresolved AD ${expectedKind} "${trimmed}".`);
      return;
    }

    const id = res.identity;
    const addUnique = (arr: ResolvedAdIdentity[]): ResolvedAdIdentity[] =>
      arr.some((x) => x.numericId === id.numericId) ? arr : [...arr, id];

    if (bucket === 'rw_group') {
      if (roGroups.some((g) => g.numericId === id.numericId)) {
        setIdentityError(`Group "${id.normalized}" is already in Read-Only Groups; remove conflict first.`);
        return;
      }
      setRwGroups(addUnique);
    } else if (bucket === 'ro_group') {
      if (rwGroups.some((g) => g.numericId === id.numericId)) {
        setIdentityError(`Group "${id.normalized}" is already in Read/Write Groups; read-only users/groups must not conflict.`);
        return;
      }
      setRoGroups(addUnique);
    } else if (bucket === 'rw_user') {
      if (roUsers.some((u) => u.numericId === id.numericId)) {
        setIdentityError(`User "${id.normalized}" is already in Read-Only Users.`);
        return;
      }
      setRwUsers(addUnique);
    } else {
      if (rwUsers.some((u) => u.numericId === id.numericId)) {
        setIdentityError(`User "${id.normalized}" is already in Read/Write Users.`);
        return;
      }
      setRoUsers(addUnique);
    }

    setIdentityInput('');
    setSuggestionIdx(-1);
    setIdentityError(undefined);
  };

  const finalizeDraftShare = (): void => {
    const resolvedPath = subfolder ? path.posix.join(selectedBaseMount, subfolder) : selectedBaseMount;

    const draft: SambaShareConfig = {
      name: shareName,
      description,
      baseMountPoint: selectedBaseMount,
      sharePath: resolvedPath,
      accessMode,
      readOnlyGroups: roGroups,
      readWriteGroups: accessMode === 'read_write' ? rwGroups : [],
      readOnlyUsers: roUsers,
      readWriteUsers: accessMode === 'read_write' ? rwUsers : [],
      createdAt: new Date().toISOString(),
    };

    const consistencyErrs = validateShareAclConsistency(draft);
    if (consistencyErrs.length > 0) {
      setIdentityError(consistencyErrs.join(' '));
      return;
    }

    setShares((prev) => [...prev, draft]);
    resetWizardDraft();
    setPhase('share_list');
  };

  const applyAllShares = async (): Promise<void> => {
    setPhase('applying');
    const res = await sambaManager.applySharesAndReload(shares, configuredMountPoints, adConfig);
    setApplyResult(res);
    if (res.success) {
      onComplete(shares, res);
    } else {
      setErrorMsg(res.error ?? 'Failed to apply Samba shares and POSIX ACLs.');
      setRecoverySteps(res.recoveryInstructions ?? []);
      setPhase('error');
    }
  };

  // Pagination helpers for mounts, shares, and remove list
  const listPageSize = Math.max(4, pageHeight - 10);
  const mountTotalPages = Math.max(1, Math.ceil(configuredMountPoints.length / listPageSize));
  const mountPage = Math.min(Math.floor(mountIdx / listPageSize), mountTotalPages - 1);
  const visibleMounts = configuredMountPoints.slice(mountPage * listPageSize, (mountPage + 1) * listPageSize);

  const shareTotalPages = Math.max(1, Math.ceil(shares.length / listPageSize));
  const sharePage = Math.min(Math.floor(listCursor / listPageSize), shareTotalPages - 1);
  const visibleShares = shares.slice(sharePage * listPageSize, (sharePage + 1) * listPageSize);

  const removePageSize = 4;
  const removeTotalPages = Math.max(1, Math.ceil(addedItems.length / removePageSize));
  const removePage = Math.min(Math.floor(removeCursor / removePageSize), removeTotalPages - 1);
  const visibleRemoveItems = addedItems.slice(removePage * removePageSize, (removePage + 1) * removePageSize);

  useInput((input, key) => {
    if (phase === 'wizard_mount') {
      if (key.escape) {
        if (shares.length > 0) setPhase('share_list');
        else onBack();
        return;
      }
      if (key.upArrow && configuredMountPoints.length > 0) {
        setMountIdx((prev) => (prev - 1 + configuredMountPoints.length) % configuredMountPoints.length);
        return;
      }
      if (key.downArrow && configuredMountPoints.length > 0) {
        setMountIdx((prev) => (prev + 1) % configuredMountPoints.length);
        return;
      }
      if (key.return && configuredMountPoints.length > 0) {
        setPhase('wizard_details');
      }
      return;
    }

    if (phase === 'wizard_details') {
      if (key.escape) {
        setPhase('wizard_mount');
        return;
      }
      if (key.upArrow || (key.tab && key.shift)) {
        setDetailFocus((prev) => (prev - 1 + 4) % 4);
        return;
      }
      if (key.downArrow || key.tab) {
        setDetailFocus((prev) => (prev + 1) % 4);
        return;
      }
      if (detailFocus === 3 && (input === ' ' || key.leftArrow || key.rightArrow)) {
        setAccessMode((prev) => (prev === 'read_write' ? 'read_only' : 'read_write'));
        return;
      }
      if (detailFocus === 3 && key.return) {
        validateShareDetailsAndAdvance();
      }
      return;
    }

    if (phase === 'wizard_identities' && !validatingId) {
      if (key.ctrl && (input.toLowerCase() === 's' || input.toLowerCase() === 'd')) {
        finalizeDraftShare();
        return;
      }

      if (identityFocusMode === 'remove_list') {
        if (key.escape || key.tab || input.toLowerCase() === 'i') {
          setIdentityFocusMode('input');
          return;
        }
        if (key.upArrow || input === 'k') {
          setRemoveCursor((prev) => (addedItems.length > 0 ? (prev - 1 + addedItems.length) % addedItems.length : 0));
          return;
        }
        if (key.downArrow || input === 'j') {
          setRemoveCursor((prev) => (addedItems.length > 0 ? (prev + 1) % addedItems.length : 0));
          return;
        }
        if (key.backspace || key.delete || key.return || input === '\x7f' || input.toLowerCase() === 'x' || input.toLowerCase() === 'r') {
          const item = addedItems[removeCursor];
          if (item) {
            removeIdentityItem(item.bucket, item.identity.numericId);
          }
        }
        return;
      }

      if (key.escape) {
        setPhase('wizard_details');
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'r') {
        if (addedItems.length > 0) {
          setRemoveCursor(0);
          setIdentityFocusMode('remove_list');
        } else {
          setIdentityError('No added users or groups to remove yet.');
        }
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'x') {
        undoLastInActiveBucket();
        return;
      }
      if (key.tab) {
        const available: IdentityBucket[] =
          accessMode === 'read_write' ? ['rw_group', 'ro_group', 'rw_user', 'ro_user'] : ['ro_group', 'ro_user'];
        const step = key.shift ? -1 : 1;
        const nextIdx = (available.indexOf(bucket) + step + available.length) % available.length;
        setBucket(available[nextIdx]!);
        setSuggestionIdx(-1);
        setIdentityError(undefined);
        return;
      }
      if (key.downArrow && suggestions.length > 0) {
        setSuggestionIdx((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (key.upArrow && suggestions.length > 0) {
        setSuggestionIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
        return;
      }
      if (key.rightArrow && suggestionIdx >= 0 && suggestions[suggestionIdx]) {
        setIdentityInput(suggestions[suggestionIdx]!);
        setSuggestionIdx(-1);
      }
      return;
    }

    if (phase === 'share_list') {
      if (key.escape || input.toLowerCase() === 'b') {
        onBack();
        return;
      }
      if (input.toLowerCase() === 'n') {
        resetWizardDraft();
        setPhase('wizard_mount');
        return;
      }
      if (key.upArrow && shares.length > 0) {
        setListCursor((prev) => (prev - 1 + shares.length) % shares.length);
        return;
      }
      if (key.downArrow && shares.length > 0) {
        setListCursor((prev) => (prev + 1) % shares.length);
        return;
      }
      if ((key.leftArrow || key.pageUp) && shareTotalPages > 1) {
        setListCursor(Math.max(0, sharePage - 1) * listPageSize);
        return;
      }
      if ((key.rightArrow || key.pageDown) && shareTotalPages > 1) {
        setListCursor(Math.min(shareTotalPages - 1, sharePage + 1) * listPageSize);
        return;
      }
      if (input.toLowerCase() === 'd' && shares.length > 0) {
        setShares((prev) => prev.filter((_, i) => i !== listCursor));
        setListCursor(0);
        return;
      }
      if (key.return && shares.length > 0) {
        setPhase('confirm_apply');
      }
    }
  });

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') setPhase('share_list');
    else if (action === 'back') onBack();
    else onExit();
  };

  if (configuredMountPoints.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} height={pageHeight}>
        <ErrorScreen
          title="No Configured LVM Mount Points Available"
          message="Samba shares must be created exclusively on configured LVM mount points. Arbitrary paths are not permitted."
          recoveryInstructions={['Complete Stage 5 (LVM) and Stage 6 (XFS and Mount Configuration) before adding shares.']}
          allowRetry={false}
          onAction={(a) => (a === 'exit' ? onExit() : onBack())}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Samba Share & POSIX ACL Permissions"
          stageId="samba"
          badgeText={`${shares.length} share${shares.length === 1 ? '' : 's'}`}
          badgeColor={shares.length > 0 ? 'green' : 'cyan'}
        />

        {phase === 'wizard_mount' && (
          <Box flexDirection="column" marginTop={1}>
            <Box justifyContent="space-between" height={1}>
              <Text bold>Select Configured LVM Mount Point (arbitrary paths disallowed):</Text>
              {mountTotalPages > 1 && <Text color="cyan">Page {mountPage + 1}/{mountTotalPages}</Text>}
            </Box>
            <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginTop={1}>
              {visibleMounts.map((mp, relIdx) => {
                const absIdx = mountPage * listPageSize + relIdx;
                return (
                  <Box key={mp} height={1}>
                    <Text
                      backgroundColor={absIdx === mountIdx ? 'cyan' : undefined}
                      color={absIdx === mountIdx ? 'black' : 'white'}
                      bold={absIdx === mountIdx}
                    >
                      {absIdx === mountIdx ? ' ▸ ' : '   '}
                      {mp}
                      {mp === preferredMountPoint ? ' (latest)' : ''}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {phase === 'wizard_details' && (
          <Box flexDirection="column">
            <Box height={1}>
              <Text color="green">✓ Base LVM Mount Point: {selectedBaseMount}</Text>
            </Box>
            <InputField
              label="Share Name"
              value={shareName}
              onChange={(v) => {
                setShareName(v);
                setDetailErrors((prev) => ({ ...prev, name: '' }));
                setDetailErrorSummary(undefined);
              }}
              onSubmit={() => setDetailFocus(1)}
              placeholder="e.g., finance"
              error={detailErrors['name'] || undefined}
              focused={detailFocus === 0}
              suppressInlineError
              compact
            />
            <InputField
              label="Description"
              value={description}
              onChange={(v) => {
                setDescription(v);
                setDetailErrors((prev) => ({ ...prev, description: '' }));
                setDetailErrorSummary(undefined);
              }}
              onSubmit={() => setDetailFocus(2)}
              placeholder="e.g., Finance Department Share"
              error={detailErrors['description'] || undefined}
              focused={detailFocus === 1}
              suppressInlineError
              compact
            />
            <InputField
              label="Subfolder (optional)"
              value={subfolder}
              onChange={(v) => {
                setSubfolder(v);
                setDetailErrors((prev) => ({ ...prev, subfolder: '' }));
                setDetailErrorSummary(undefined);
              }}
              onSubmit={() => setDetailFocus(3)}
              placeholder="Empty = mount root, or e.g. finance"
              error={detailErrors['subfolder'] || undefined}
              focused={detailFocus === 2}
              suppressInlineError
              compact
            />
            <Box marginTop={1} height={1}>
              <Text bold color={detailFocus === 3 ? 'cyan' : 'white'}>
                {detailFocus === 3 ? '▸ ' : '  '}
                {'Access Mode:'.padEnd(22, ' ')}
              </Text>
              <Text
                bold
                color={accessMode === 'read_write' ? 'black' : 'gray'}
                backgroundColor={accessMode === 'read_write' ? 'green' : undefined}
              >
                {' '}Read / Write{' '}
              </Text>
              <Text>  </Text>
              <Text
                bold
                color={accessMode === 'read_only' ? 'black' : 'gray'}
                backgroundColor={accessMode === 'read_only' ? 'yellow' : undefined}
              >
                {' '}Read Only{' '}
              </Text>
            </Box>
            <Box height={1} marginTop={1}>
              <Text color={detailErrorSummary ? 'red' : 'gray'}>
                {detailErrorSummary ? `✖ ${detailErrorSummary}` : ' '}
              </Text>
            </Box>
          </Box>
        )}

        {phase === 'wizard_identities' && (
          <Box flexDirection="column">
            <Box justifyContent="space-between" height={1}>
              <Text bold>
                AD ACLs for [{shareName}] ({accessMode === 'read_write' ? 'Read/Write' : 'Read-Only'})
              </Text>
              <Text color={identityFocusMode === 'remove_list' ? 'yellow' : 'cyan'} bold>
                {identityFocusMode === 'remove_list' ? 'MODE: REMOVE ADDED' : 'MODE: ADD / AUTOCOMPLETE'}
              </Text>
            </Box>

            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor={identityFocusMode === 'remove_list' ? 'yellow' : 'gray'}
              paddingX={1}
              height={6}
            >
              {identityFocusMode === 'remove_list' ? (
                <>
                  <Box justifyContent="space-between" height={1}>
                    <Text bold color="yellow">
                      Select added user/group and press [Del/Backspace/Enter] to remove:
                    </Text>
                    {removeTotalPages > 1 && <Text color="yellow">Page {removePage + 1}/{removeTotalPages}</Text>}
                  </Box>
                  {visibleRemoveItems.map((item, relIdx) => {
                    const absIdx = removePage * removePageSize + relIdx;
                    const active = absIdx === removeCursor;
                    return (
                      <Box key={`${item.bucket}-${item.identity.numericId}`} height={1}>
                        <Text
                          backgroundColor={active ? 'red' : undefined}
                          color="white"
                          bold={active}
                        >
                          {active ? ' ✖ ' : '   '}[{item.tag}] {item.identity.normalized} (ID {item.identity.numericId})
                        </Text>
                      </Box>
                    );
                  })}
                </>
              ) : (
                <>
                  {accessMode === 'read_write' && (
                    <Box height={1}>
                      <Text color={bucket === 'rw_group' ? 'cyan' : 'white'} bold={bucket === 'rw_group'}>
                        {bucket === 'rw_group' ? '▸ ' : '  '}RW Groups ({rwGroups.length}):{' '}
                        {rwGroups.map((g) => `${g.normalized}(${g.numericId})`).join(', ') || 'None'}
                      </Text>
                    </Box>
                  )}
                  <Box height={1}>
                    <Text color={bucket === 'ro_group' ? 'cyan' : 'white'} bold={bucket === 'ro_group'}>
                      {bucket === 'ro_group' ? '▸ ' : '  '}RO Groups ({roGroups.length}):{' '}
                      {roGroups.map((g) => `${g.normalized}(${g.numericId})`).join(', ') || 'None'}
                    </Text>
                  </Box>
                  {accessMode === 'read_write' && (
                    <Box height={1}>
                      <Text color={bucket === 'rw_user' ? 'cyan' : 'white'} bold={bucket === 'rw_user'}>
                        {bucket === 'rw_user' ? '▸ ' : '  '}RW Users [Opt] ({rwUsers.length}):{' '}
                        {rwUsers.map((u) => `${u.normalized}(${u.numericId})`).join(', ') || 'None'}
                      </Text>
                    </Box>
                  )}
                  <Box height={1}>
                    <Text color={bucket === 'ro_user' ? 'cyan' : 'white'} bold={bucket === 'ro_user'}>
                      {bucket === 'ro_user' ? '▸ ' : '  '}RO Users [Opt] ({roUsers.length}):{' '}
                      {roUsers.map((u) => `${u.normalized}(${u.numericId})`).join(', ') || 'None'}
                    </Text>
                  </Box>
                </>
              )}
            </Box>

            <InputField
              label={`Add ${bucket.replace('_', ' ').toUpperCase()}`}
              value={identityInput}
              onChange={(v) => {
                setIdentityInput(v);
                setSuggestionIdx(-1);
                setIdentityError(undefined);
              }}
              onSubmit={(v) => void handleAddIdentity(v)}
              placeholder={`Type AD ${isGroupBucket ? 'group' : 'user'} name...`}
              error={identityError}
              focused={!validatingId && identityFocusMode === 'input'}
              suppressInlineError
              compact
            />

            {/* Fixed-height suggestions/status box keeps layout rock-steady */}
            <Box flexDirection="column" borderStyle="single" borderColor={identityError ? 'red' : 'blue'} paddingX={1} height={4}>
              {validatingId ? (
                <ProgressBar percent={50} label="Verifying identity with wbinfo --name-to-sid and getent..." />
              ) : identityError ? (
                <Text color="red">✖ {identityError}</Text>
              ) : identityFocusMode === 'input' && suggestions.length > 0 ? (
                <>
                  <Text dimColor>
                    Suggestions ({isGroupBucket ? 'AD Groups' : 'AD Users'}) — [↑/↓] Select, [→] Fill, [Enter] Add:
                  </Text>
                  <Box flexWrap="wrap" gap={2} height={1}>
                    {suggestions.map((sug, idx) => {
                      const selected = idx === suggestionIdx;
                      return (
                        <Text
                          key={sug}
                          bold={selected}
                          color={selected ? 'black' : 'cyan'}
                          backgroundColor={selected ? 'cyan' : undefined}
                        >
                          {selected ? ` ▸ ${sug} ` : `  ${sug}`}
                        </Text>
                      );
                    })}
                  </Box>
                </>
              ) : (
                <Text dimColor>
                  {identityFocusMode === 'remove_list'
                    ? 'Remove Mode: press [Backspace/Del/Enter] to remove highlighted item, [Esc/Tab] to resume typing.'
                    : `Type an AD ${isGroupBucket ? 'group' : 'username'} and press [Enter] to validate and add.`}
                </Text>
              )}
            </Box>
          </Box>
        )}

        {phase === 'share_list' && (
          <Box flexDirection="column" marginTop={1}>
            <Box justifyContent="space-between" height={1}>
              <Text bold>Configured & Staged Shares ({shares.length}):</Text>
              {shareTotalPages > 1 && <Text color="cyan">Page {sharePage + 1}/{shareTotalPages}</Text>}
            </Box>
            <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginTop={1}>
              {visibleShares.map((s, relIdx) => {
                const absIdx = sharePage * listPageSize + relIdx;
                return (
                  <Box key={s.name} height={1}>
                    <Text
                      backgroundColor={absIdx === listCursor ? 'cyan' : undefined}
                      color={absIdx === listCursor ? 'black' : 'white'}
                      bold={absIdx === listCursor}
                    >
                      {absIdx === listCursor ? ' ▸ ' : '   '}[{s.name}] {s.sharePath} ({s.accessMode}) — RW Grps:{' '}
                      {s.readWriteGroups.length}, RO Grps: {s.readOnlyGroups.length}, Users:{' '}
                      {s.readWriteUsers.length + s.readOnlyUsers.length}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {phase === 'confirm_apply' && (
          <Confirmation
            title="Apply POSIX ACLs, Update smb.conf, Validate & Reload Samba"
            message={[
              `Shares to configure: ${shares.map((s) => `${s.name} -> ${s.sharePath}`).join(', ')}`,
              'Steps: Back up /etc/samba/smb.conf → Apply chown/chmod 2770/setfacl → Write smb.conf → Run testparm -s → Reload smbd.',
            ]}
            confirmLabel="Apply & Validate Samba"
            cancelLabel="Back to Share List"
            onConfirm={() => void applyAllShares()}
            onCancel={() => setPhase('share_list')}
          />
        )}

        {phase === 'applying' && (
          <Box marginTop={1}>
            <ProgressBar percent={70} label="Applying POSIX ACLs, validating smb.conf with testparm, and reloading smbd..." />
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="Samba & ACL Configuration Failed"
            message={errorMsg}
            details={applyResult?.testparmOutput ? [applyResult.testparmOutput] : []}
            recoveryInstructions={recoverySteps}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box height={1} paddingX={1}>
        {phase === 'wizard_mount' && (
          <Text dimColor>[↑/↓] Select  •  [Enter] Next  •  [Esc] {shares.length > 0 ? 'Share List' : 'Main Menu'}</Text>
        )}
        {phase === 'wizard_details' && (
          <Text dimColor>[↑/↓/Tab] Navigate  •  [Space] Toggle RW/RO  •  [Enter on Access Mode] Next  •  [Esc] Back</Text>
        )}
        {phase === 'wizard_identities' && (
          <Text dimColor>
            [Tab] Switch List • [Ctrl+R] Remove Added • [Ctrl+X] Undo • [Ctrl+D/S] Save Share • [Esc] Back
          </Text>
        )}
        {phase === 'share_list' && (
          <Text dimColor>
            [N] Add Share  •  [D] Remove  •  {shareTotalPages > 1 ? '[←/→] Page  •  ' : ''}[Enter] Apply & Reload  •  [B/Esc] Menu
          </Text>
        )}
      </Box>
    </Box>
  );
};
