#![cfg(test)]

use super::*;
use soroban_sdk::{symbol_short, Env};

#[test]
fn get_votes_returns_zero_for_unseen_option() {
    let env = Env::default();
    let contract_id = env.register(LivePollContract, ());
    let client = LivePollContractClient::new(&env, &contract_id);
    let option_a = symbol_short!("OptionA");
    let option_b = symbol_short!("OptionB");

    assert_eq!(client.get_votes(&option_a), 0);
    assert_eq!(client.get_votes(&option_b), 0);
}

#[test]
fn vote_accumulates_votes_for_the_same_option() {
    let env = Env::default();
    let contract_id = env.register(LivePollContract, ());
    let client = LivePollContractClient::new(&env, &contract_id);
    let option_a = symbol_short!("OptionA");

    client.vote(&option_a);
    client.vote(&option_a);
    client.vote(&option_a);

    assert_eq!(client.get_votes(&option_a), 3);
}

#[test]
fn vote_tracks_each_option_independently() {
    let env = Env::default();
    let contract_id = env.register(LivePollContract, ());
    let client = LivePollContractClient::new(&env, &contract_id);
    let option_a = symbol_short!("OptionA");
    let option_b = symbol_short!("OptionB");

    client.vote(&option_a);
    client.vote(&option_a);
    client.vote(&option_b);

    assert_eq!(client.get_votes(&option_a), 2);
    assert_eq!(client.get_votes(&option_b), 1);
}
