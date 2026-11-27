import { describe, expect, test } from 'bun:test';
import { validateInput } from '../src/validation/retry.js';
import {
  activeDirectoryInputSchema,
  adDomainSchema,
  adIdentityInputSchema,
  dcIpAddressSchema,
  hostnameSchema,
  lvmBaseNameSchema,
  mountPointSchema,
  netbiosNameSchema,
  safeDevicePathSchema,
  sambaDescriptionSchema,
  sambaShareNameSchema,
  wipeConfirmationSchema,
} from '../src/validation/schemas.js';

describe('Validation Schemas', () => {
  test('hostnameSchema accepts valid Linux hostnames and rejects invalid ones', () => {
    expect(validateInput(hostnameSchema, 'fileserver01').success).toBe(true);
    expect(validateInput(hostnameSchema, 'FS-NODE-1').data).toBe('fs-node-1');

    expect(validateInput(hostnameSchema, '').success).toBe(false);
    expect(validateInput(hostnameSchema, '-badhost').success).toBe(false);
    expect(validateInput(hostnameSchema, 'bad_host').success).toBe(false);
    expect(validateInput(hostnameSchema, 'localhost').success).toBe(false);
    expect(validateInput(hostnameSchema, '12345').success).toBe(false);
    expect(validateInput(hostnameSchema, 'a'.repeat(64)).success).toBe(false);
  });

  test('adDomainSchema and netbiosNameSchema validate AD domain names cleanly', () => {
    expect(validateInput(adDomainSchema, 'Corp.Example.COM').data).toBe('corp.example.com');
    expect(validateInput(adDomainSchema, 'singlelabel').success).toBe(false);
    expect(validateInput(adDomainSchema, 'bad..domain.com').success).toBe(false);

    expect(validateInput(netbiosNameSchema, 'corp').data).toBe('CORP');
    expect(validateInput(netbiosNameSchema, 'CORP.LOCAL').success).toBe(false);
    expect(validateInput(netbiosNameSchema, 'TOOLONGNETBIOS123').success).toBe(false);
  });

  test('dcIpAddressSchema accepts valid IPv4/IPv6 and rejects loopback/unspecified', () => {
    expect(validateInput(dcIpAddressSchema, '192.168.10.10').success).toBe(true);
    expect(validateInput(dcIpAddressSchema, '2001:db8::10').success).toBe(true);
    expect(validateInput(dcIpAddressSchema, '999.168.1.1').success).toBe(false);
    expect(validateInput(dcIpAddressSchema, '127.0.0.1').success).toBe(false);
    expect(validateInput(dcIpAddressSchema, '0.0.0.0').success).toBe(false);
  });

  test('activeDirectoryInputSchema rejects shell metacharacters in username and empty passwords', () => {
    const badUser = validateInput(activeDirectoryInputSchema, {
      domain: 'corp.example.com',
      netbiosName: 'CORP',
      dcIp: '10.0.0.5',
      username: 'admin;rm -rf /',
      password: 'SecretPassword1!',
    });
    expect(badUser.success).toBe(false);
    expect(badUser.fieldErrors['username']).toBeDefined();

    const emptyPass = validateInput(activeDirectoryInputSchema, {
      domain: 'corp.example.com',
      netbiosName: 'CORP',
      dcIp: '10.0.0.5',
      username: 'Administrator',
      password: '',
    });
    expect(emptyPass.success).toBe(false);
    expect(emptyPass.fieldErrors['password']).toBeDefined();
  });

  test('lvmBaseNameSchema enforces single base name without vg_/lv_ prefixes', () => {
    expect(validateInput(lvmBaseNameSchema, 'fileserver').data).toBe('fileserver');
    expect(validateInput(lvmBaseNameSchema, 'vg_fileserver').success).toBe(false);
    expect(validateInput(lvmBaseNameSchema, 'lv_data').success).toBe(false);
    expect(validateInput(lvmBaseNameSchema, 'ubuntu-vg').success).toBe(false);
  });

  test('wipeConfirmationSchema requires exact uppercase WIPE', () => {
    expect(validateInput(wipeConfirmationSchema, 'WIPE').success).toBe(true);
    expect(validateInput(wipeConfirmationSchema, 'wipe').success).toBe(false);
    expect(validateInput(wipeConfirmationSchema, 'yes').success).toBe(false);
  });

  test('mountPointSchema enforces safe absolute paths outside OS directories', () => {
    expect(validateInput(mountPointSchema, '/data/fileserver/').data).toBe('/data/fileserver');
    expect(validateInput(mountPointSchema, 'data/fileserver').success).toBe(false);
    expect(validateInput(mountPointSchema, '/etc/samba').success).toBe(false);
    expect(validateInput(mountPointSchema, '/usr/local/share').success).toBe(false);
    expect(validateInput(mountPointSchema, '/data/../etc/passwd').success).toBe(false);
    expect(validateInput(mountPointSchema, '/').success).toBe(false);
  });

  test('samba share and identity schemas block INI injection and reserved names', () => {
    expect(validateInput(sambaShareNameSchema, 'finance').success).toBe(true);
    expect(validateInput(sambaShareNameSchema, 'global').success).toBe(false);
    expect(validateInput(sambaShareNameSchema, 'ipc$').success).toBe(false);
    expect(validateInput(sambaDescriptionSchema, 'Finance [Admin]').success).toBe(false);
    expect(validateInput(adIdentityInputSchema, 'CORP\\Domain Users').success).toBe(true);
    expect(validateInput(adIdentityInputSchema, 'bad\ninjection').success).toBe(false);
    expect(validateInput(safeDevicePathSchema, '/dev/sdb').success).toBe(true);
    expect(validateInput(safeDevicePathSchema, '/dev/../etc/shadow').success).toBe(false);
  });
});
