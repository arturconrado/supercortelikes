from media_worker.seo import ctr_score, generate_seo


def test_seo_generates_twenty_ranked_titles_and_metadata():
    transcript = (
        "Investimento financeiro exige estratégia e controle de risco. " * 5
    ) + "Clientes precisam entender dinheiro e renda."
    result = generate_seo(
        transcript, subject="investimentos", audience="empreendedores"
    )
    assert len(result["titles"]) == 20
    assert result["titles"][0]["ctrScore"] >= result["titles"][-1]["ctrScore"]
    assert result["keywords"]
    assert result["hashtags"]
    assert "empreendedores" in result["description"]


def test_ctr_score_rewards_curiosity_and_question():
    assert ctr_score("Você conhece o segredo que ninguém conta?") > ctr_score(
        "Uma conversa bastante comum"
    )
