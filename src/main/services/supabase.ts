import { createClient } from '@supabase/supabase-js';
import { secretStore } from './secrets';

export interface SupabaseRpcError {
  message: string;
}

export interface SupabaseRpcResult<T> {
  data: T | null;
  error: SupabaseRpcError | null;
}

export interface SupabaseRpcClient {
  rpc<T>(functionName: string, args: Record<string, unknown>): Promise<SupabaseRpcResult<T>>;
}

export async function createSupabaseRpcClient(): Promise<SupabaseRpcClient> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL is not configured');
  }

  const anonKey = (await secretStore.get('supabase_anon_key')) ?? process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error('Supabase anon key is not configured');
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return {
    rpc: async <T>(
      functionName: string,
      args: Record<string, unknown>,
    ): Promise<SupabaseRpcResult<T>> => {
      const { data, error } = await supabase.rpc(functionName, args);
      return {
        data: data as T | null,
        error: error ? { message: error.message } : null,
      };
    },
  };
}
