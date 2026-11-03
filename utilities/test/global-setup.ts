import { migrate } from '../src/migrate.js';

export default async function setup() {
  await migrate(process.env.TEST_DATABASE_URL ?? 'postgres://utilities_owner:dev@localhost/utilities_test');
}
