import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';

const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'broadcasthost', 'ip6-localhost']);

export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Hostname cannot be empty.')
  .max(63, 'Hostname must be 63 characters or fewer (Linux HOST_NAME_MAX label rule).')
  .refine((val) => HOSTNAME_LABEL_RE.test(val), {
    message:
      'Hostname must contain only lowercase letters (a-z), digits (0-9), and hyphens (-), and cannot start or end with a hyphen.',
  })
  .refine((val) => !/^\d+$/.test(val), {
    message: 'Hostname cannot be purely numeric.',
  })
  .refine((val) => !RESERVED_HOSTNAMES.has(val), {
    message: 'Hostname cannot be a reserved loopback name such as "localhost".',
  });

export const adDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'AD DNS domain must be a valid fully qualified domain name (e.g., corp.example.com).')
  .max(253, 'AD DNS domain exceeds maximum DNS length of 253 characters.')
  .refine((val) => val.includes('.'), {
    message: 'AD DNS domain must contain at least one dot (e.g., corp.example.com).',
  })
  .refine(
    (val) => {
      const labels = val.split('.');
      if (labels.length < 2) return false;
      const tld = labels[labels.length - 1] ?? '';
      if (/^\d+$/.test(tld)) return false;
      return labels.every((lbl) => HOSTNAME_LABEL_RE.test(lbl));
    },
    {
      message:
        'Each domain label must contain only lowercase letters, digits, or hyphens, cannot start/end with a hyphen, and the TLD cannot be purely numeric.',
    },
  );

export const netbiosNameSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Domain NetBIOS name cannot be empty.')
  .max(15, 'Domain NetBIOS name must be 15 characters or fewer.')
  .refine((val) => /^[A-Z0-9][A-Z0-9_-]{0,14}$/.test(val), {
    message:
      'NetBIOS name must start with an uppercase letter or digit and contain only A-Z, 0-9, underscore, or hyphen (no dots or spaces).',
  })
  .refine((val) => !/^\d+$/.test(val), {
    message: 'NetBIOS name cannot be purely numeric.',
  });

export const dcIpAddressSchema = z
  .string()
  .trim()
  .min(1, 'Domain Controller IP address is required.')
  .refine((val) => net.isIP(val) !== 0, {
    message: 'Must be a valid IPv4 or IPv6 address (e.g., 192.168.10.10).',
  })
  .refine(
    (val) => {
      if (val === '0.0.0.0' || val === '255.255.255.255' || val === '::') return false;
      if (val.startsWith('127.') || val === '::1') return false;
      return true;
    },
    {
      message: 'Domain Controller IP cannot be a loopback, unspecified, or broadcast address.',
    },
  );

export const adUsernameSchema = z
  .string()
  .trim()
  .min(1, 'Domain-join username cannot be empty.')
  .max(104, 'Username is too long.')
  .refine((val) => !/[\r\n\t\0"'`;|&$<>()[\]{}]/.test(val), {
    message: 'Username contains forbidden control or shell characters.',
  })
  .refine((val) => /^[a-zA-Z0-9._@-]+(\\[a-zA-Z0-9._-]+)?$/.test(val) || /^[a-zA-Z0-9._-]+$/.test(val), {
    message: 'Username must contain only valid Active Directory account characters (letters, digits, ., _, -, @, \\).',
  });

export const passwordSchema = z
  .string()
  .min(1, 'Password cannot be empty.')
  .max(256, 'Password exceeds maximum supported length.')
  .refine((val) => !val.includes('\0') && !val.includes('\n') && !val.includes('\r'), {
    message: 'Password cannot contain null bytes or newline characters.',
  });

export const activeDirectoryInputSchema = z.object({
  domain: adDomainSchema,
  netbiosName: netbiosNameSchema,
  dcIp: dcIpAddressSchema,
  username: adUsernameSchema,
  password: passwordSchema,
});

const RESERVED_LVM_NAMES = new Set([
  '.',
  '..',
  'root',
  'swap',
  'ubuntu-vg',
  'ubuntu-lv',
  'all',
  'default',
]);

export const lvmBaseNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'LVM name must be at least 2 characters long.')
  .max(48, 'LVM name must be 48 characters or fewer.')
  .refine((val) => /^[a-z0-9][a-z0-9_-]*$/.test(val), {
    message:
      'LVM name must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or hyphens.',
  })
  .refine((val) => !val.startsWith('vg_') && !val.startsWith('lv_'), {
    message:
      'Provide only the base LVM name (for example "fileserver"), without "vg_" or "lv_" prefixes; they are generated automatically.',
  })
  .refine((val) => !RESERVED_LVM_NAMES.has(val), {
    message: 'That LVM name is reserved by the system. Choose another name such as "fileserver".',
  });

export const wipeConfirmationSchema = z
  .string()
  .trim()
  .refine((val) => val === 'WIPE', {
    message: 'You must type WIPE in uppercase letters to confirm erasing the selected disks.',
  });

const FORBIDDEN_MOUNT_EXACT = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/media',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/snap',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
]);

const FORBIDDEN_MOUNT_PREFIXES = ['/bin/', '/boot/', '/dev/', '/etc/', '/lib', '/proc/', '/root/', '/run/', '/sbin/', '/sys/', '/usr/', '/var/'];

export const mountPointSchema = z
  .string()
  .trim()
  .min(2, 'Mount point path cannot be empty.')
  .max(255, 'Mount point path is too long.')
  .refine((val) => val.startsWith('/'), {
    message: 'Mount point must be an absolute path starting with "/".',
  })
  .refine((val) => !/[\0\r\n\t\s]/.test(val), {
    message: 'Mount point path cannot contain whitespace, tabs, newlines, or null bytes.',
  })
  .refine((val) => !val.split('/').includes('..') && !val.split('/').includes('.'), {
    message: 'Mount point path cannot contain "." or ".." path segments.',
  })
  .transform((val) => path.posix.normalize(val).replace(/\/+$/, '') || '/')
  .refine((val) => !FORBIDDEN_MOUNT_EXACT.has(val), {
    message: 'Mount point cannot overwrite a standard system directory.',
  })
  .refine((val) => !FORBIDDEN_MOUNT_PREFIXES.some((prefix) => val.startsWith(prefix)), {
    message: 'Mount point cannot be placed inside protected OS directories (/etc, /usr, /var, /boot, /dev, /proc, /sys, /run).',
  });

const RESERVED_SHARE_NAMES = new Set(['global', 'homes', 'printers', 'print$', 'ipc$', 'admin$', 'c$', 'd$']);

export const sambaShareNameSchema = z
  .string()
  .trim()
  .min(1, 'Share name cannot be empty.')
  .max(64, 'Share name must be 64 characters or fewer.')
  .refine((val) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(val), {
    message: 'Share name must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens.',
  })
  .refine((val) => !RESERVED_SHARE_NAMES.has(val.toLowerCase()), {
    message: 'That share name is reserved by Samba/Windows.',
  });

export const sambaDescriptionSchema = z
  .string()
  .trim()
  .min(1, 'Share description cannot be empty.')
  .max(120, 'Share description must be 120 characters or fewer.')
  .refine((val) => !/[\r\n\0[\]]/.test(val), {
    message: 'Share description cannot contain newlines, null bytes, or square brackets [ ].',
  });

export const adIdentityInputSchema = z
  .string()
  .trim()
  .min(1, 'AD user or group name cannot be empty.')
  .max(104, 'AD identity name is too long.')
  .refine((val) => !/[\r\n\0[\];=,]/.test(val), {
    message: 'AD identity contains invalid characters.',
  });

export const safeDevicePathSchema = z
  .string()
  .trim()
  .refine((val) => /^\/dev\/[a-zA-Z0-9/_-]+$/.test(val) && !val.includes('..'), {
    message: 'Device path must be a safe /dev/* block device path.',
  });

export const shareSubfolderSchema = z
  .string()
  .trim()
  .max(64, 'Subfolder name must be 64 characters or fewer.')
  .refine((val) => val === '' || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(val), {
    message: 'Subfolder must be empty (use mount root) or a single safe directory name without slashes.',
  });
