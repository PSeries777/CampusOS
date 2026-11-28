import { http } from './api';
import type { User } from './types';

type NewUser = Pick<User, 'full_name' | 'email'> & {
  role: 'teacher' | 'student';
  password: string;
};

export const usersQueryKey = ['admin', 'users'] as const;
export const usersApi = {
  list: () => http<User[]>('/users'),
  create: (user: NewUser) => http<User>('/users', 'POST', user),
};
