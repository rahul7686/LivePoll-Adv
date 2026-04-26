#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

#[contract]
pub struct LivePollContract;

#[contractimpl]
impl LivePollContract {
    // Cast a vote for a specific option (e.g., "OptionA" or "OptionB")
    pub fn vote(env: Env, option: Symbol) {
        // Get current votes, default to 0 if none exist
        let current_votes: u32 = env.storage().instance().get(&option).unwrap_or(0);
        let new_votes = current_votes + 1;
        
        // Save the new vote count
        env.storage().instance().set(&option, &new_votes);
        
        // EMIT EVENT: This fulfills the real-time event listening requirement!
        env.events().publish((symbol_short!("voted"), option), new_votes);
    }

    // Read the current vote count for an option
    pub fn get_votes(env: Env, option: Symbol) -> u32 {
        env.storage().instance().get(&option).unwrap_or(0)
    }
}